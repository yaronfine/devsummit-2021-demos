import { subclass } from "esri/core/accessorSupport/decorators";
import Point from "esri/geometry/Point";
import Graphic from "esri/Graphic";
import BaseLayerViewGL2D from "esri/views/2d/layers/BaseLayerViewGL2D";
import { mat3, vec2 } from "gl-matrix";
import { createProgram } from "../common/webglUtils";
import * as promiseUtils from "esri/core/promiseUtils";
import { i8888to32, testVectorInsideCar } from "../common/utils";
import { Feature } from "../common/WebSocetConnection";
import { carsJSON, carsImageBase64 } from "../common/cars";

const ATTRS_PER_VERTEX = 4;
const VERTS_PER_MARKER = 6;

const C_RAD_TO_256 = 128.0 / Math.PI;

interface IPoint {
  x: number;
  y: number
}

@subclass("CustomFeatureLayer")
export default class CustomLayerView extends BaseLayerViewGL2D {  

  // --------------------------------------------------------------------------
  //
  //  Private properties
  //
  // --------------------------------------------------------------------------
  private readonly _dvsMat3 = mat3.create();
  private readonly _displayViewMat3 = mat3.create();

  private _wglProgram: WebGLProgram;
  private _vao: WebGLObject;
  private _vertexBuffer: WebGLBuffer;
  private _aPosition = 0;
  private _aTexInfo = 1;
  private _aOffsetHeding = 2;
  private _dvsMatrixLocation: WebGLUniformLocation;
  private _displayViewMatrixLocation: WebGLUniformLocation;
  private _carTextureLocation: WebGLUniformLocation;
  private _carTexSizeLocation: WebGLUniformLocation;
  private _iconRatioLocation: WebGLUniformLocation;
  private _carTexture: WebGLTexture;
  private _carTexSize: [number, number] = [0, 0];
  private _vertexBufferLength: number;
  private _vaoExt: any;
  private _bufferData: Float32Array;
  private _updateBufferData = false;
  private _updateTimer = 0;
  private _updateRequested = true;
  private _featuresToUpdate = new Map<number, Feature>();
  private _features = new Map<number, Feature>();
  private _localOrigin: IPoint = { x: 0, y: 0};
  private _carsInfo: number[];
  private _carsMetrics: { width: number, height: number }[] = [];

  // --------------------------------------------------------------------------
  //
  //  Public methods
  //
  // --------------------------------------------------------------------------
  attach(): void {
    // create the shader program
    this._wglProgram = this._createShaderProgram(this.context);

    const customLayer = this.layer as any;
    customLayer.on("onFeature", (feature: Feature) => this._onFeature(feature));

    // start the update cycle
    this._updateTimer = window.setInterval(() => this._doUpdate(), 16);

    const carsInfo = [];  
    const carsJson = JSON.parse(carsJSON)
    for (const type of Object.keys(carsJson)) {
      const carInfo = carsJson[type];
      const info = i8888to32(carInfo.xmin, carInfo.ymin, carInfo.xmax - carInfo.xmin, carInfo.ymax - carInfo.ymin);
      carsInfo.push(info);

      const width = carInfo.xmax - carInfo.xmin;
      const height = carInfo.ymax - carInfo.ymin;
      this._carsMetrics.push({ width, height });
    }

    const gl = this.context;
    const ext =
      gl.getExtension("OES_vertex_array_object") ||
      gl.getExtension("MOZ_OES_vertex_array_object") ||
      gl.getExtension("WEBKIT_OES_vertex_array_object");
    if (!ext) {
      console.error("this implementation of WebGL does not support extension OES_vertex_array_object!");
      return;
    }

    const vaoExt = {
      createVertexArray: ext.createVertexArrayOES.bind(ext),
      deleteVertexArray: ext.deleteVertexArrayOES.bind(ext),
      bindVertexArray: ext.bindVertexArrayOES.bind(ext)
    };

    // create the vertex buffer
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, 0, gl.STREAM_DRAW);

    this._vertexBufferLength = 0;

    // create the index buffer
    const vao = vaoExt.createVertexArray();
    // Start setting up the VAO state
    vaoExt.bindVertexArray(vao);

    // vertex buffer
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.vertexAttribPointer(this._aPosition, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(this._aPosition);
    gl.vertexAttribPointer(this._aTexInfo, 4, gl.UNSIGNED_BYTE, false, 16, 8);
    gl.enableVertexAttribArray(this._aTexInfo);
    gl.vertexAttribPointer(this._aOffsetHeding, 4, gl.UNSIGNED_BYTE, false, 16, 12);
    gl.enableVertexAttribArray(this._aOffsetHeding);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    // finished setting up VAO
    vaoExt.bindVertexArray(null);


    const carImage = new Image();
    carImage.src = carsImageBase64;
    carImage.onload = () => {
      const texture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, carImage);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.generateMipmap(gl.TEXTURE_2D);

      this._carTexSize[0] = carImage.width;
      this._carTexSize[1] = carImage.height;
      this._carTexture = texture;
    }


    this._carsInfo = carsInfo;
    this._vertexBuffer = vb;
    this._vao = vao;
    this._vaoExt = vaoExt;
  }

  detach(): void {
    if (this._updateTimer !== 0) {
      clearInterval(this._updateTimer);
    }

    const gl = this.context;

    if (this._vao) {
      this._vaoExt.deleteVertexArray(this._vao);
      this._vao = null;
      this._vaoExt = null;

      gl.deleteBuffer(this._vertexBuffer);
      this._vertexBuffer = null
    }

    if (this._wglProgram) {
      gl.deleteProgram(this._wglProgram);
      this._wglProgram = null;
    }

    if (this._carTexture) {
      gl.deleteTexture(this._carTexture);
      this._carTexture = null;
    }
  }

  render(renderParameters: any): void {
    if (!this._bufferData || !this._carTexture) {
      return;
    }    

    this._updateWebGL(renderParameters);

    this._updateMatrices(renderParameters);

    const state = renderParameters.state;
    const scale = state.scale;    
    const iconRatio = 10.0 / Math.log2(scale);

    const gl = renderParameters.context;

    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);

    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._carTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);    

    // bind the shader
    gl.useProgram(this._wglProgram);

    // bind the vao
    this._vaoExt.bindVertexArray(this._vao);
     
    // set the uniforms
    gl.uniformMatrix3fv(this._dvsMatrixLocation, false, this._dvsMat3);
    gl.uniformMatrix3fv(this._displayViewMatrixLocation, false, this._displayViewMat3);
    gl.uniform1i(this._carTextureLocation, 0);
    gl.uniform2fv(this._carTexSizeLocation, this._carTexSize);
    gl.uniform1f(this._iconRatioLocation, iconRatio);

    // draw
    gl.drawArrays(
      gl.TRIANGLES,
      0,
      this._vertexBufferLength / ATTRS_PER_VERTEX
    );

    this._vaoExt.bindVertexArray(null);    
  }

  // --------------------------------------------------------------------------
  //
  //  Private methods
  //
  // --------------------------------------------------------------------------  

  private _createShaderProgram(gl: WebGLRenderingContext): WebGLProgram {
    const vertexSource =
      `precision highp float;
        uniform mat3 u_dvsMat3;
        uniform mat3 u_displayViewMat3;
        uniform vec2 u_texSize;
        uniform float u_iconRatio;

        attribute vec2 a_position;
        attribute vec4 a_texInfo;
        attribute vec4 a_offestHeading;

        varying vec2 v_texCoord;       
        
        mat3 getRotationMat(float rotationValue) {
          float angle = rotationValue;
          float sinA = sin(angle);
          float cosA = cos(angle);
        
          return mat3( cosA, -sinA, 0.0, 
                      sinA,  cosA,  0.0, 
                       0.0,   0.0,  1.0);
        }

        const float C_256_TO_RAD = 3.14159265359 / 128.0;

        void main() {
          mediump vec2 imageSize = a_texInfo.zw;
          mediump float heading = C_256_TO_RAD * a_offestHeading.z;
          mediump vec2 offset = a_offestHeading.xy - vec2(0.5);

          mediump vec3 pos = u_dvsMat3 * vec3(a_position, 1.0) + u_displayViewMat3 * getRotationMat(heading) * vec3(u_iconRatio * imageSize * offset, 0.0);
          gl_Position = vec4(pos.xy, 0.0, 1.0);
        
          v_texCoord = (a_texInfo.xy + a_offestHeading.xy * imageSize) / u_texSize;
        }`;

  const fragmentSource =
    `precision mediump float;
     uniform sampler2D u_texture; 
    
      varying vec2 v_texCoord;      

      void main() {
        gl_FragColor = texture2D(u_texture, v_texCoord);
      }`;


    const attributeLocationMap = new Map([[this._aPosition, "a_position"], [this._aTexInfo, "a_texInfo"], [this._aOffsetHeding, "a_offestHeading"]]); 
    const program = createProgram(gl, vertexSource, fragmentSource, attributeLocationMap);

    this._dvsMatrixLocation = gl.getUniformLocation(
      program,
      "u_dvsMat3"
    );

    this._displayViewMatrixLocation = gl.getUniformLocation(
      program,
      "u_displayViewMat3"
    );

    this._carTextureLocation = gl.getUniformLocation(
      program,
      "u_texture"
    );

    this._carTexSizeLocation = gl.getUniformLocation(
      program,
      "u_texSize"
    );

    this._iconRatioLocation = gl.getUniformLocation(
      program,
      "u_iconRatio"
    );

    return program;
  } 

  private _updateWebGL(renderParameters: any): void {
    if (!this._updateBufferData) {
      return;
    }

    const gl = renderParameters.context;
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this._bufferData, gl.STREAM_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    
    this._updateBufferData = false;
  }

  private _updateMatrices(renderParameters: any): void {
    const state = renderParameters.state;
    const { size, resolution, rotation, viewpoint } = state;
    const rads = (Math.PI / 180) * rotation;    
    const displayViewMat3 = mat3.identity(this._displayViewMat3);  
    const w = size[0] !== 0 ? 2 / size[0] : 0;
    const h = size[1] !== 0 ? -2 / size[1] : 0;
    mat3.set(displayViewMat3, w, 0, 0, 0, h, 0, -1, 1, 1);

    const viewPointGeometry = viewpoint.targetGeometry as Point;
    const centerX = viewPointGeometry.x - this._localOrigin.x;
    const centerY = viewPointGeometry.y - this._localOrigin.y;
    const widthInMapUnits = resolution * size[0];
    const heightInMapUnits = resolution * size[1];

    const viewMat3 = mat3.identity(this._dvsMat3);
    mat3.multiply(viewMat3, displayViewMat3, viewMat3);
    mat3.translate(viewMat3, viewMat3, vec2.fromValues(size[0] / 2, size[1] / 2));
    mat3.scale(viewMat3, viewMat3, vec2.fromValues(size[0] / widthInMapUnits, -size[1] / heightInMapUnits));
    mat3.rotate(viewMat3, viewMat3, -rads);
    mat3.translate(viewMat3, viewMat3, vec2.fromValues(-centerX, -centerY));
    
    // we want the cars to be map aligned, so we need to deal with the map's rotation    
    mat3.translate(displayViewMat3, displayViewMat3, vec2.fromValues(size[0] / 2, size[1] / 2));
    mat3.rotate(displayViewMat3, displayViewMat3, rads);
    mat3.translate(displayViewMat3, displayViewMat3, vec2.fromValues(-size[0] / 2, -size[1] / 2));    
  }

  private _onFeature(feature: Feature): void {
    if (!feature) {
      return;
    }

    const { attributes } = feature;
    const trackId = attributes["TRACKID"];    
    this._featuresToUpdate.set(trackId, feature);

    this._updateRequested = true;
  }

  private _doUpdate(): void {
    if (!this._updateRequested) {
      return;
    }
        
    const featuresToUpdateMap = this._featuresToUpdate;
    const features = this._features;

    const updateBuffer = featuresToUpdateMap.size > 0;
    if (!updateBuffer) {
      return;
    }
    
    const { extent, viewpoint } = this.view;

    const featuresToUpdate = featuresToUpdateMap.entries();
    let updateResult = featuresToUpdate.next();
    while (!updateResult.done) {
      const [trackId, feature] = updateResult.value;
      features.set(trackId, feature);
      updateResult = featuresToUpdate.next();
    }
    
    featuresToUpdateMap.clear();

    const { x, y } = viewpoint.targetGeometry as Point;
    const localX = this._localOrigin.x = x;
    const localY = this._localOrigin.y = y;

    const clipExtent = extent.clone();
    clipExtent.expand(1.15);

    const vertexBufferLength = ATTRS_PER_VERTEX * VERTS_PER_MARKER * features.size;    

    const carsInfo = this._carsInfo;

    const vertexData = new Float32Array(vertexBufferLength);
    const vertexDataU32 = new Uint32Array(vertexData.buffer);

    let i = 0;
    let dx: number, dy: number;
    let heading: number;
    let texInfo: number;
    let feature: Feature;
    const allFeatures = features.values();
    let result = allFeatures.next();
    while (!result.done) {      
      feature = result.value;
      result = allFeatures.next();
      const { x, y } = feature.geometry;
      if (x < clipExtent.xmin || x > clipExtent.xmax || y < clipExtent.ymin || y > clipExtent.ymax) {
        continue;
      }

      const attributes = feature.attributes;
      dx = x - localX;
      dy = y - localY;
      heading = C_RAD_TO_256 * attributes["HEADING"];
      texInfo = carsInfo[attributes["TYPE"]];


      vertexData[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 0]    = dx;
      vertexData[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 1]    = dy;
      vertexDataU32[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 2] = texInfo;
      vertexDataU32[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 3] = i8888to32(0, 0, heading, 0);

      vertexData[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 4]    = dx;
      vertexData[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 5]    = dy;
      vertexDataU32[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 6] = texInfo;
      vertexDataU32[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 7] = i8888to32(1, 0, heading, 0);

      vertexData[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 8]   = dx;
      vertexData[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 9]   = dy;
      vertexDataU32[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 10] = texInfo;
      vertexDataU32[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 11] = i8888to32(0, 1, heading, 0);

      vertexData[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 12]   = dx;
      vertexData[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 13]   = dy;
      vertexDataU32[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 14] = texInfo;
      vertexDataU32[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 15] = i8888to32(1, 0, heading, 0);

      vertexData[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 16]   = dx;
      vertexData[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 17]   = dy;
      vertexDataU32[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 18] = texInfo;
      vertexDataU32[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 19] = i8888to32(1, 1, heading, 0);

      vertexData[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 20]   = dx;
      vertexData[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 21]   = dy;
      vertexDataU32[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 22] = texInfo;
      vertexDataU32[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 23] = i8888to32(0, 1, heading, 0);

      i++;
    }

    // We allocated data considering all the features, but in reallity, we potentially clipped many of them
    // Calculate the actual buffer lenght (how many bytes we actually encoded)
    this._vertexBufferLength = i * ATTRS_PER_VERTEX * VERTS_PER_MARKER;
    // this is an optimization, we reallocate the buffer if we clipped half or more of the features
    if (this._vertexBufferLength < 0.5 *  vertexBufferLength) {
      this._bufferData = new Float32Array(vertexData.buffer, 0, this._vertexBufferLength);
    } else {
      this._bufferData = vertexData;
    }
    this._updateBufferData = true;

    this.requestRender();
    this._updateRequested = false;
  }

  hitTest(x: number, y: number): Promise<Graphic> {
    let minDistance = Infinity;
    let foundProperties: any;
    const scale = this.view.scale;
    const iconRatio = 10.0 / Math.log2(scale);
    const spatialReference = this.view.spatialReference;
    
    for (const feature of Array.from(this._features.values())) {
      const { x: xMap, y: yMap } = feature.geometry;
      const { x: xScreen, y: yScreen } = this.view.toScreen(new Point({ x: xMap, y: yMap, spatialReference }));
      
      const metrics = this._carsMetrics[feature.attributes["TYPE"]];      
      const W = metrics.width * iconRatio;
      const H = metrics.height * iconRatio;

      // Early rejection by checking the distance
      // against a circumscribed circle that encloses
      // the car.
      const R = Math.max(W, H);
      const dx = x - xScreen;
      const dy = y - yScreen;
      if (dx * dx + dy * dy > R * R) {
        continue;
      }
      
      const isInside = testVectorInsideCar(
        W, H,
        Math.PI * this.view.rotation / 180 - feature.attributes["HEADING"],
        dx, dy
      );
      const distanceFromCenter = Math.sqrt(dx * dx + dy * dy);
      if (isInside && distanceFromCenter < minDistance) {
        minDistance = distanceFromCenter;
        foundProperties = {
          attributes: feature.attributes
        };
      }
    }

    if (foundProperties) {
      const g = new Graphic(foundProperties);
      (g as any).sourceLayer = this.layer;
      return promiseUtils.resolve(g);
    }

    return promiseUtils.resolve();
  }
}