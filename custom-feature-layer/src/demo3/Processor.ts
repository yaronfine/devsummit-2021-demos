import * as promiseUtils from "esri/core/promiseUtils";

import { Maybe } from "../common/maybe";
import { i8888to32, testVectorInsideCar } from "../common/utils";
import { Feature, WebSocketConnection, IWebSocketConnectionConfig } from "../common/WebSocetConnection";

const ATTRS_PER_VERTEX = 4;
const VERTS_PER_MARKER = 6;

const C_RAD_TO_256 = 128.0 / Math.PI;

export default class Processor {

  // -----------------------------------------------------
  //
  //   Lifecycle
  //
  // -----------------------------------------------------

  async initialize(params: { 
    config: IWebSocketConnectionConfig, carsJSON: any }, 
    options?: { client: any; signal?: Maybe<AbortSignal> }
    ): Promise<void>  {
    const { config, carsJSON } = params;
    this._remoteClient = options?.client;
    const carsInfo = [];
    const carsJson = JSON.parse(carsJSON)
    for (const type of Object.keys(carsJson)) {
      const carInfo = carsJson[type];
      const info = i8888to32(carInfo.xmin, carInfo.ymin, carInfo.xmax - carInfo.xmin, carInfo.ymax - carInfo.ymin);
      carsInfo.push(info)

      const width = carInfo.xmax - carInfo.xmin;
      const height = carInfo.ymax - carInfo.ymin;
      this._carsMetrics.push({ width, height });
    }

    this._carsInfo = carsInfo;

    let onConnectionStatusChange: (status: string) => void;
    
    const promise = promiseUtils.create((resolve, reject) => {
      onConnectionStatusChange = (status: string) => {
        if (status === "connected") {
          resolve();
        } else {
          reject();
        }
      }
    });    

    this._webSocketConnection = new WebSocketConnection(config, (feature: Feature) => this._onFeature(feature), onConnectionStatusChange);

    this._updateTimer = self.setInterval(() => this._doUpdate(), 16);
    
    return promise;
  }

  terminate(): void {
    if (this._updateTimer !== 0) {
      clearInterval(this._updateTimer);
    }

    // TODO: clos ethe connection
    if (this._webSocketConnection && this._webSocketConnection.connectionStatus === "connected") {
      this._webSocketConnection.destroy();
    }

    this._webSocketConnection = null;
  }

  // -----------------------------------------------------
  //
  //   Properties
  //
  // -----------------------------------------------------  

  private _webSocketConnection: WebSocketConnection;
  private _remoteClient: any;
  private _updateTimer = 0;
  private _featuresToUpdate = new Map<number, Feature>();
  private _updateRequested = true;
  private _features = new Map<number, Feature>();  
  private _carsInfo: number[];
  private _carsMetrics: { width: number, height: number }[] = [];
  private _viewpoint: { x: number, y: number };
  private _visibleExtent: { xmin: number, ymin: number, xmax: number, ymax: number };

  // ----------------------------------------------------- 
  //
  //  Public methods
  //
  // ----------------------------------------------------- 

  setViewState(params: 
    { 
      viewpoint: { 
        x: number, 
        y: number 
      }, 
      visibleExtent: { 
        xmin: number, 
        ymin: number, 
        xmax: number, 
        ymax: number 
      }
    }): void {
    const { viewpoint, visibleExtent } = params;
    this._viewpoint = viewpoint;    
    
    // we need to expand the visible extent by 15 percent
    const deltaf = 0.15 * 0.5;
    const { xmin, ymin, xmax, ymax } = visibleExtent;
    const deltaWidth = deltaf * (xmax - xmin);
    const deltaHeight = deltaf * (ymax - ymin);

    this._visibleExtent = {
      xmin: xmin - deltaWidth,
      ymin: ymin - deltaHeight,
      xmax: xmax + deltaWidth,
      ymax: ymax + deltaHeight,
     };
  }

  async hittest(params: { mapPoint: {x: number, y: number}, resolution: number, scale: number, rotation: number }): Promise<Feature> {
    const {mapPoint, resolution, scale, rotation} = params;
    const carMetrics = this._carsMetrics;
    const iconRatio = 10.0 / Math.log2(scale);

    for (const feature of Array.from(this._features.values())) {
      const { x, y } = feature.geometry;
      const metrics = carMetrics[feature.attributes["TYPE"]];    
    
      const w = metrics.width * iconRatio * resolution;
      const h = metrics.height * iconRatio * resolution;

      const R = Math.max(w, h);
      const dx = x - mapPoint.x;
      const dy = y - mapPoint.y;
      if (dx * dx + dy * dy > R * R) {
        continue;
      }

      const isInside = testVectorInsideCar(
        w, h,
        Math.PI * rotation / 180 - feature.attributes["HEADING"],
        dx, dy
      );

      if (isInside) {
        return feature;
      }  
    }

    return null;
  }


  // ----------------------------------------------------- 
  //
  //  Private methods
  //
  // ----------------------------------------------------- 

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
    if (!this._updateRequested || !this._viewpoint) {
      return;
    }

    const featuresToUpdateMap = this._featuresToUpdate;
    const features = this._features;

    const updateBuffer = featuresToUpdateMap.size > 0;
    if (!updateBuffer) {
      return;
    }

    const featuresToUpdate = featuresToUpdateMap.entries();
    let updateResult = featuresToUpdate.next();
    while (!updateResult.done) {
      const [trackId, feature] = updateResult.value;
      features.set(trackId, feature);
      updateResult = featuresToUpdate.next();
    }
    
    featuresToUpdateMap.clear();

    const { x, y } = this._viewpoint;
    const clipExtent = this._visibleExtent; 
    const localX =  x;
    const localY = y;
       
    const carsInfo = this._carsInfo;    

    let vertexBufferLength = ATTRS_PER_VERTEX * VERTS_PER_MARKER * features.size;    


    let vertexData = new Float32Array(vertexBufferLength);
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

    
    const bufferLength = i * ATTRS_PER_VERTEX * VERTS_PER_MARKER;
    let buffer: ArrayBuffer;
    if (this._remoteClient) {
      if (bufferLength < 0.75 * vertexBufferLength ) {
        buffer = vertexData.slice(0, bufferLength).buffer;
      } else {
        buffer = vertexData.buffer;
      }      

      this._remoteClient.invoke("setData", 
        { 
          data: buffer, 
          bufferLength,
          localOrigin: { x, y }
        },
        {          
          transferList: [buffer]
        }
      );
    }

    this._updateRequested = false;
  }
}