import { subclass } from "esri/core/accessorSupport/decorators";
import Point from "esri/geometry/Point";
import Graphic from "esri/Graphic";
import BaseLayerViewGL2D from "esri/views/2d/layers/BaseLayerViewGL2D";
import { mat3, vec2 } from "gl-matrix";
import { createProgram } from "../common/webglUtils";
import * as promiseUtils from "esri/core/promiseUtils";
import { i8888to32 } from "../common/utils";
import { Feature } from "../common/WebSocetConnection";
import { carsJSON, carsImageBase64 } from "../common/cars";

const ATTRS_PER_VERTEX = 4;
const VERTS_PER_MARKER = 6;

const MARKER_SIZE = 30;
const C_RAD_TO_256 = 128.0 / Math.PI;

const BlurDirectionX = [1.0, 0.0];
const BlurDirectionY = [0.0, 1.0];

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
  private _wglHighlightProgram: WebGLProgram;
  private _vao: WebGLObject;
  private _vertexBuffer: WebGLBuffer;
  private _aPosition = 0;
  private _aTexInfo = 1;
  private _aOffsetHedingActive = 2;
  private _dvsMatrixLocation: WebGLUniformLocation;
  private _displayViewMatrixLocation: WebGLUniformLocation;
  private _carTextureLocation: WebGLUniformLocation;
  private _carTexSizeLocation: WebGLUniformLocation;
  private _iconRatioLocation: WebGLUniformLocation;
  private _dvsMatrixLocation2: WebGLUniformLocation;
  private _displayViewMatrixLocation2: WebGLUniformLocation;
  private _carTextureLocation2: WebGLUniformLocation;
  private _carTexSizeLocation2: WebGLUniformLocation;
  private _iconRatioLocation2: WebGLUniformLocation;
  private _time: WebGLUniformLocation;
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
  private _highlightActiveCars = false;
  private _wglBlitProgram: WebGLProgram;
  private _wglGaussianBlurProgram: WebGLProgram;
  private _fboSize: [number, number] = [0, 0];
  private _fbo1: WebGLFramebuffer;
  private _fbo2: WebGLFramebuffer;
  private _colorTexture1: WebGLTexture;
  private _colorTexture2: WebGLTexture;
  private _blitTextureLocation: WebGLUniformLocation;
  private _blitTime: WebGLUniformLocation;
  private _colorTextureLocation: WebGLUniformLocation;
  private _colorTexSizeLocation: WebGLUniformLocation;
  private _directionLocation: WebGLUniformLocation;
  private _sigmaLocation: WebGLUniformLocation;
  private _fullQuadVAO: WebGLObject;
  private _fullQuadVBO: WebGLBuffer;

  // --------------------------------------------------------------------------
  //
  //  Public methods
  //
  // --------------------------------------------------------------------------
  attach(): void {
    // create the shader program
    this._wglProgram = this._createShaderCarsProgram(this.context);
    this._wglHighlightProgram = this._createShaderCarsProgram(this.context, ["HIGHLIGHT_PATH"]);
    this._createBlurShaders(this.context);

    const customLayer = this.layer as any;
    customLayer.on("onFeature", (feature: Feature) => this._onFeature(feature));
    customLayer.watch("showActive", (value: boolean) => this._highlightActiveCars = value);

    // start the update cycle
    this._updateTimer = window.setInterval(() => this._doUpdate(), 16);

    // we pack the vertex attributes in a 32bit buffer, therefore we perpack the texture attributes per car
    const carsInfo = [];
    const carsJson = JSON.parse(carsJSON)
    for (const type of Object.keys(carsJson)) {
      const carInfo = carsJson[type];
      const info = i8888to32(carInfo.xmin, carInfo.ymin, carInfo.xmax - carInfo.xmin, carInfo.ymax - carInfo.ymin);
      carsInfo.push(info)
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

    // create the cars buffer
    const vao = vaoExt.createVertexArray();
    // Start setting up the VAO state
    vaoExt.bindVertexArray(vao);

    // vertex buffer
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.vertexAttribPointer(this._aPosition, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(this._aPosition);
    gl.vertexAttribPointer(this._aTexInfo, 4, gl.UNSIGNED_BYTE, false, 16, 8);
    gl.enableVertexAttribArray(this._aTexInfo);
    gl.vertexAttribPointer(this._aOffsetHedingActive, 4, gl.UNSIGNED_BYTE, false, 16, 12);
    gl.enableVertexAttribArray(this._aOffsetHedingActive);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    // finished setting up VAO
    vaoExt.bindVertexArray(null);


    // load the cars atlas
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

    // create a VAO for the full quad draw:
    const fullQuadVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, fullQuadVBO);
    gl.bufferData(gl.ARRAY_BUFFER, new Int8Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);    

    // create the index buffer
    const fullQuadVAO = vaoExt.createVertexArray();
    // Start setting up the VAO state
    vaoExt.bindVertexArray(fullQuadVAO);

    // vertex buffer
    gl.bindBuffer(gl.ARRAY_BUFFER, fullQuadVBO);
    gl.vertexAttribPointer(this._aPosition, 2, gl.BYTE, false, 2, 0);
    gl.enableVertexAttribArray(this._aPosition); 
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    // finished setting up the full quad VAO
    vaoExt.bindVertexArray(null);

    // create first fbo:
    const fbo1 = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo1);

    // create a color texture for fbo1
    const colorTex1 = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, colorTex1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      
    // attach the texture as the first color attachment
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colorTex1, 0);

    // this is a rather slow code. Normally we prevent it from executing in release mode
    const framebufferStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (framebufferStatus !== gl.FRAMEBUFFER_COMPLETE) {
      console.error("Framebuffer is incomplete!");
    }

    // create first fbo:
    const fbo2 = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo2);

    // create a color texture for fbo1
    const colorTex2 = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, colorTex2);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      
    // attach the texture as the first color attachment
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colorTex2, 0);

    // this is a rather slow code. Normally we prevent it from executing in release mode
    const framebufferStatus2 = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (framebufferStatus2 !== gl.FRAMEBUFFER_COMPLETE) {
      console.error("Framebuffer is incomplete!");
    }

    this.bindRenderTarget();

    this._fullQuadVBO = fullQuadVBO;
    this._fullQuadVAO = fullQuadVAO;
    this._fboSize = [1, 1];
    this._fbo1 = fbo1;
    this._colorTexture1 = colorTex1;
    this._fbo2 = fbo2;
    this._colorTexture2 = colorTex2;
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
    this.bindRenderTarget();

    if (this._vao) {
      this._vaoExt.deleteVertexArray(this._vao);
      this._vao = null;      

      gl.deleteBuffer(this._vertexBuffer);
      this._vertexBuffer = null
    }

    if (this._fullQuadVAO) {
      this._vaoExt.deleteVertexArray(this._fullQuadVAO);
      this._fullQuadVAO = null;      

      gl.deleteBuffer(this._fullQuadVBO);
      this._fullQuadVBO = null;
      this._vaoExt = null;
    }

    if (this._wglProgram) {
      gl.deleteProgram(this._wglProgram);
      this._wglProgram = null;
    }

    if (this._wglHighlightProgram) {
      gl.deleteProgram(this._wglHighlightProgram);
      this._wglHighlightProgram = null;
    }

    if (this._wglGaussianBlurProgram) {
      gl.deleteProgram(this._wglGaussianBlurProgram);
      this._wglGaussianBlurProgram = null;
    }

    if (this._wglBlitProgram) {
      gl.deleteProgram(this._wglBlitProgram);
      this._wglBlitProgram = null;
    }

    if (this._carTexture) {
      gl.deleteTexture(this._carTexture);
      this._carTexture = null;
    }

    if (this._fbo1) {
      gl.deleteFramebuffer(this._fbo1);
      this._fbo1 = null;
    }

    if (this._fbo2) {
      gl.deleteFramebuffer(this._fbo2);
      this._fbo2 = null;
    }

    if (this._colorTexture1) {
      gl.deleteTexture(this._colorTexture1);
      this._colorTexture1 = null;
    }

    if (this._colorTexture2) {
      gl.deleteTexture(this._colorTexture2);
      this._colorTexture2 = null;
    }
  }

  render(renderParameters: any): void {
    if (!this._bufferData || !this._carTexture) {
      return;
    }    

    this._updateWebGLResources(renderParameters);

    this._updateMatrices(renderParameters);

    const state = renderParameters.state;
    const scale = state.scale;    
    let iconRatio = 0.75 * 10.0 / Math.log2(scale);

    const gl = renderParameters.context;
    const vaoExt = this._vaoExt;

    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.clearColor(0.0, 0.0, 0.0, 0.0);

    // we are using pre-multiplied colors
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._carTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);

    // bind the shader
    gl.useProgram(this._wglProgram);

    // bind the vao
    vaoExt.bindVertexArray(this._vao);
     
    // set the uniforms
    gl.uniformMatrix3fv(this._dvsMatrixLocation, false, this._dvsMat3);
    gl.uniformMatrix3fv(this._displayViewMatrixLocation, false, this._displayViewMat3);
    gl.uniform1i(this._carTextureLocation, 0);
    gl.uniform2fv(this._carTexSizeLocation, this._carTexSize);
    gl.uniform1f(this._iconRatioLocation, iconRatio);

    // render the cars    
    gl.drawArrays(
      gl.TRIANGLES,
      0,
      this._vertexBufferLength / 4
    );

    if (this._highlightActiveCars) {   
      const { state, pixelRatio } = renderParameters;
      const { size } = state;
      const viewSize = [Math.round(pixelRatio * size[0]), Math.round(pixelRatio * size[1])];
      const time = performance.now();
      gl.viewport(0, 0, viewSize[0], viewSize[1]);

      gl.disable(gl.BLEND)

      // bind target FBO
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo1);    
      gl.clear(gl.COLOR_BUFFER_BIT);
      
      // bind highlight cars shader
      gl.useProgram(this._wglHighlightProgram);

      // set the uniforms
      gl.uniformMatrix3fv(this._dvsMatrixLocation2, false, this._dvsMat3);
      gl.uniformMatrix3fv(this._displayViewMatrixLocation2, false, this._displayViewMat3);
      gl.uniform1i(this._carTextureLocation2, 0);
      gl.uniform2fv(this._carTexSizeLocation2, this._carTexSize);
      gl.uniform1f(this._iconRatioLocation2, iconRatio);
      gl.uniform1f(this._time, time / 10.0);      

      // draw only the active cars (dilated)
      gl.drawArrays(
        gl.TRIANGLES,
        0,
        this._vertexBufferLength / 4
      );
      
      // bind the full quad VAO
      vaoExt.bindVertexArray(this._fullQuadVAO);
      
      // bind fbo2 as the render target for the horizontal blur pass
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo2);      

      // bind blur shader program for the blur passes
      gl.useProgram(this._wglGaussianBlurProgram);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this._colorTexture1); // we use the color texture of FBO1 as an input
      gl.uniform1i(this._colorTextureLocation, 1);
      gl.uniform2fv(this._colorTexSizeLocation, viewSize);
      gl.uniform2fv(this._directionLocation, BlurDirectionX);
      gl.uniform1f(this._sigmaLocation, 5); // TODO: we may be using a non discrete number here

      // render the horizintal blur pass
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // now bind fbo1 as the render target (for the vertical blur pass)
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo1);      
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this._colorTexture2); // we use the color texture of FBO2 as an input
      gl.uniform1i(this._colorTextureLocation, 2);      
      gl.uniform2fv(this._directionLocation, BlurDirectionY);
      
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // bind the default back-buffer FBO      
      this.bindRenderTarget();
      gl.enable(gl.BLEND);

      // bind the blit shader program
      gl.useProgram(this._wglBlitProgram);

      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, this._colorTexture1);
      gl.uniform1i(this._blitTextureLocation, 3); 
      gl.uniform1f(this._blitTime, time / 10.0);
      
      // blit the blured texture on top of the back-buffer
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      
      this.requestRender();
    }

    vaoExt.bindVertexArray(null);    
  }

  // --------------------------------------------------------------------------
  //
  //  Private methods
  //
  // --------------------------------------------------------------------------  

  private _createShaderCarsProgram(gl: WebGLRenderingContext, defines?: string[]): WebGLProgram {
    let vertexSource =
      `precision highp float;
#pragma defines      
        uniform mat3 u_dvsMat3;
        uniform mat3 u_displayViewMat3;
        uniform vec2 u_texSize;
        uniform float u_iconRatio;

#ifdef HIGHLIGHT_PATH        
        uniform float u_time;        
#endif

        attribute vec2 a_position;
        attribute vec4 a_texInfo;
        attribute vec4 a_offestHeadingActive;

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
          mediump float heading = C_256_TO_RAD * a_offestHeadingActive.z;
          mediump vec2 offset = a_offestHeadingActive.xy - vec2(0.5);

          mediump float deltaZ = 0.5;
          mediump float dilateFactor = 1.0;

#ifdef HIGHLIGHT_PATH
          deltaZ += step(a_offestHeadingActive.w, 0.0);
          float timeFactor = mod(u_time, 100.0) / 100.0;
          if (timeFactor > 0.5) {
            timeFactor = 1.0 - timeFactor;
          }

          dilateFactor = 1.0 + timeFactor;
#endif

          mediump vec3 pos = u_dvsMat3 * vec3(a_position, 1.0) + u_displayViewMat3 * getRotationMat(heading) * vec3(u_iconRatio * dilateFactor * imageSize * offset, 0.0);
          gl_Position = vec4(pos.xy, deltaZ, 1.0);
        
          v_texCoord = (a_texInfo.xy + a_offestHeadingActive.xy * imageSize) / u_texSize;
        }`;

  const fragmentSource =
    `precision mediump float;

     uniform sampler2D u_texture;
     
     varying vec2 v_texCoord;

      void main() {        
        gl_FragColor = texture2D(u_texture, v_texCoord);
      }`;

    if (defines) {
      let definesString = "";
      for (const d of defines) {
      definesString += `#define ${d}\n`;
      }  

      const regex = /#pragma defines/g;
      vertexSource = vertexSource.replace(regex, definesString);      
    }

    const attributeLocationMap = new Map([[this._aPosition, "a_position"], [this._aTexInfo, "a_texInfo"], [this._aOffsetHedingActive, "a_offestHeadingActive"]]); 
    const program = createProgram(gl, vertexSource, fragmentSource, attributeLocationMap);

    if (defines) {
      this._dvsMatrixLocation2 = gl.getUniformLocation(
        program,
        "u_dvsMat3"
      );

      this._displayViewMatrixLocation2 = gl.getUniformLocation(
        program,
        "u_displayViewMat3"
      );

      this._carTextureLocation2 = gl.getUniformLocation(
        program,
        "u_texture"
      );

      this._carTexSizeLocation2 = gl.getUniformLocation(
        program,
        "u_texSize"
      );

      this._iconRatioLocation2 = gl.getUniformLocation(
        program,
        "u_iconRatio"
      );

      this._time = gl.getUniformLocation(
        program,
        "u_time"
      );
    } else {
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
    }

    return program;
  }
  
  private _createBlurShaders(gl: WebGLRenderingContext): void {
    const vertexSource = `
      // full quad vertex shader
      precision mediump float;

      attribute vec2 a_position;


      varying vec2 v_uv;

      void main() {
        gl_Position = vec4(2.0 * a_position - vec2(1.0), 0.0, 1.0);
        v_uv = a_position;
      }`;

    const blitSource = `
      precision mediump float;

      uniform sampler2D u_blitTexture;
      uniform float u_time;

      varying vec2 v_uv;
      void main() {
        float alpha = 0.5 * texture2D(u_blitTexture, v_uv).a;        
        float isOutline = smoothstep(0.1, 0.25, alpha);
        alpha += 0.25 * (1.0 - step(alpha, 0.0)) * clamp(1.0 - mod(u_time, 100.0) / 100.0, 0.0, 1.0);
        float outlineFactor = 3.0 * isOutline;
        
        gl_FragColor = isOutline * vec4(0.0, alpha, alpha, alpha) + (1.0 - isOutline) * vec4(outlineFactor, 0.0, 0.0, outlineFactor);
      }`;

    const gaussianBlurSource = `
      precision mediump float;

      uniform sampler2D u_colorTexture;
      uniform vec2 u_texSize;
      uniform vec2 u_direction;
      uniform float u_sigma;
      
      varying vec2 v_uv;
      
      #define KERNEL_RADIUS 5
      
      float gaussianPdf(in float x, in float sigma) {
          return 0.39894 * exp(-0.5 * x * x / ( sigma * sigma)) / sigma;
      }
      
      void main() {
        vec2 invSize = 1.0 / u_texSize;
        float fSigma = u_sigma;
        float weightSum = gaussianPdf(0.0, fSigma);
        vec4 pixelColorSum = texture2D(u_colorTexture, v_uv) * weightSum;
      
        for (int i = 1; i < KERNEL_RADIUS; i ++) {
          float x = float(i);
          float w = gaussianPdf(x, fSigma);
          vec2 uvOffset = u_direction * invSize * x;
          vec4 sample1 = texture2D(u_colorTexture, v_uv + uvOffset);
          vec4 sample2 = texture2D(u_colorTexture, v_uv - uvOffset);
          pixelColorSum += (sample1 + sample2) * w;
          weightSum += 2.0 * w;
        }
      
        gl_FragColor = pixelColorSum / weightSum;
      }`;

    const attributeLocationMap = new Map([[this._aPosition, "a_position"]]); 
    const blitProgram = createProgram(gl, vertexSource, blitSource, attributeLocationMap);

    this._blitTextureLocation = gl.getUniformLocation(
      blitProgram,
      "u_blitTexture"
    );

    this._blitTime = gl.getUniformLocation(
      blitProgram,
      "u_time"
    );

    const gaussianBlurProgram = createProgram(gl, vertexSource, gaussianBlurSource, attributeLocationMap);

    this._colorTextureLocation = gl.getUniformLocation(
      gaussianBlurProgram,
      "u_colorTexture"
    );

    this._colorTexSizeLocation = gl.getUniformLocation(
      gaussianBlurProgram,
      "u_texSize"
    );

    this._directionLocation = gl.getUniformLocation(
      gaussianBlurProgram,
      "u_direction"
    ); 

    this._sigmaLocation = gl.getUniformLocation(
      gaussianBlurProgram,
      "u_sigma"
    );
    
    this._wglBlitProgram = blitProgram;
    this._wglGaussianBlurProgram = gaussianBlurProgram;
  }

  private _updateWebGLResources(renderParameters: any): void {
    const { state, context } = renderParameters;
    const gl = context;
    const { size } = state;
    if (this._fboSize[0] !== size[0] || this._fboSize[1] !== size[1]) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._colorTexture1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size[0], size[1], 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

      gl.bindTexture(gl.TEXTURE_2D, this._colorTexture2);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size[0], size[1], 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindTexture(gl.TEXTURE_2D, null);
      
      this._fboSize[0] = size[0];
      this._fboSize[1] = size[1];
    }  

    if (!this._updateBufferData) {
      return;
    }

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
    let active = 0;
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
      active = attributes["ACTIVE"];
      texInfo = carsInfo[attributes["TYPE"]];

      vertexData[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 0]    = dx;
      vertexData[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 1]    = dy;
      vertexDataU32[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 2] = texInfo;
      vertexDataU32[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 3] = i8888to32(0, 0, heading, active);

      vertexData[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 4]    = dx;
      vertexData[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 5]    = dy;
      vertexDataU32[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 6] = texInfo;
      vertexDataU32[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 7] = i8888to32(1, 0, heading, active);

      vertexData[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 8]   = dx;
      vertexData[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 9]   = dy;
      vertexDataU32[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 10] = texInfo;
      vertexDataU32[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 11] = i8888to32(0, 1, heading, active);

      vertexData[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 12]   = dx;
      vertexData[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 13]   = dy;
      vertexDataU32[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 14] = texInfo;
      vertexDataU32[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 15] = i8888to32(1, 0, heading, active);

      vertexData[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 16]   = dx;
      vertexData[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 17]   = dy;
      vertexDataU32[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 18] = texInfo;
      vertexDataU32[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 19] = i8888to32(1, 1, heading, active);

      vertexData[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 20]   = dx;
      vertexData[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 21]   = dy;
      vertexDataU32[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 22] = texInfo;
      vertexDataU32[i * ATTRS_PER_VERTEX * VERTS_PER_MARKER + 23] = i8888to32(0, 1, heading, active);

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

    this._features.forEach((feature, id) => {
      const { x: xMap, y: yMap } = feature.geometry;
      const { x: xScreen, y: yScreen } = this.view.toScreen(new Point({ x: xMap, y: yMap, spatialReference: this.view.spatialReference }));
      const dx = xScreen - x;
      const dy = yScreen - y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance < (MARKER_SIZE / 2) && distance < minDistance) {
        minDistance = distance;
        foundProperties = {
          attributes: {
            ID: "" + id,
            SPEED: "36 mph" // TODO!
          }
        };
      }
    });

    if (foundProperties) {
      const g = new Graphic(foundProperties);
      (g as any).sourceLayer = this.layer;
      return promiseUtils.resolve(g);
    }

    return promiseUtils.resolve();
  }
}
