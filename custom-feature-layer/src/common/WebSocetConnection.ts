// esri.core
import { Maybe, isNone, isSome } from "../common/maybe";
import { after, createResolver } from "../common/promiseUtils";

export interface Feature {
  displayId?: number;
  geometry?: any;
  attributes: HashMap<any>;
  centroid?: {
    x: number;
    y: number;
  };
}

export enum ReadyState {
  CONNECTING = 0,
  OPEN = 1,
  CLOSING = 2,
  CLOSED = 3
}

export interface IWebSocketConnectionConfig {
  filter: Maybe<any>; //??
  geometryType: string; // "point"
  maxReconnectionAttempts: number;
  maxReconnectionInterval: number;
  outFields?: string[];
  source: string; // url
  sourceSpatialReference: any;
  spatialReference: any;
}

export class WebSocketConnection {
  // -----------------------------------------------------
  //
  //   Lifecycle
  //
  // -----------------------------------------------------

  constructor(config: IWebSocketConnectionConfig, onFeature: (feature: Feature) => void, onConnectionStatusChange: (status: string) => void) {    
    this._config = config;
    this._onFeature = onFeature;
    this._onConnectionStatusChange = onConnectionStatusChange;

    this._open();
  }

  protected async _open(): Promise<void> {
    await this._tryCreateWebSocket();

    if (!this.destroyed) {
      await this._handshake();
    }

    this._onConnectionStatusChange(this.connectionStatus);
  }

  destroy(): void {
    if (isSome(this._websocket)) {
      this._websocket.onopen = null;
      this._websocket.onclose = null;
      this._websocket.onerror = null;
      this._websocket.onmessage = null;
      this._websocket.close();
    }

    this._websocket = null;

    this.destroyed = true;

    this._onConnectionStatusChange(this.connectionStatus);
  }

  // -----------------------------------------------------
  //
  //   Properties
  //
  // -----------------------------------------------------  

  private _websocket: Maybe<WebSocket>;

  private _config: IWebSocketConnectionConfig;

  private _onFeature: (feature: Feature) => void;
  private _onConnectionStatusChange: (status: string) => void;
  

  //----------------------------------
  //  connectionStatus
  //----------------------------------
  
  get connectionStatus(): string {
    if (isNone(this._websocket)) {
      return "disconnected";
    }

    switch (this._websocket.readyState) {
      case ReadyState.CONNECTING:
      case ReadyState.OPEN:
        return "connected";
      case ReadyState.CLOSING:
      case ReadyState.CLOSED:
        return "disconnected";
    }

    return undefined;
  }

  //----------------------------------
  //  destroyed
  //----------------------------------

  destroyed: boolean = false;

  //----------------------------------
  //  errorString
  //----------------------------------
  
  errorString: string = null;

  // -----------------------------------------------------
  //
  //   Private Methods
  //
  // -----------------------------------------------------

  protected async _tryCreateWebSocket(url = this._config.source, timeout = 1000, depth = 0): Promise<void> {
    try {
      if (this.destroyed) {
        return;
      }

      this._websocket = await this._createWebSocket(url);      
    } catch (e) {
      const seconds = timeout / 1000;

      if (this._config.maxReconnectionAttempts && depth >= this._config.maxReconnectionAttempts) {
        console.error(        
            "websocket-connection",
            `Exceeded maxReconnectionAttempts attempts. No further attempts will be made`
          );
        

        this.destroy();
        return;
      }

      console.error("websocket-connection", `Failed to connect. Attempting to reconnect in ${seconds}s`);
      await after(timeout);
      
      return this._tryCreateWebSocket(
        url,
        Math.min(timeout * 1.5, this._config.maxReconnectionInterval * 1000),
        depth + 1
      );
    }
  }

  protected _createWebSocket(url: string): Promise<WebSocket> {
    const websocket = new WebSocket(url);
    const promise = new Promise<WebSocket>((resolve, reject) => {
      websocket.onopen = () => resolve(websocket);
      websocket.onclose = (e) => reject(e);
    });

    promise.then(() => {
      if (this.destroyed) {
        websocket.onclose = () => {};
        websocket.close();
        return;
      }

      websocket.onclose = (e) => this._onClose(e);
      websocket.onerror = (e) => this._onError(e);
      websocket.onmessage = (message) => this._onMessage(message);
    });

    return promise;
  }

  protected async _handshake(timeout = 10000): Promise<void> {
    const websocket = this._websocket;

    if (isNone(websocket)) {
      return;
    }

    const resolver = createResolver<void>();
    const handler = websocket.onmessage;

    const { filter, outFields, spatialReference } = this._config;

    resolver.timeout(timeout);

    websocket.onmessage = (event: MessageEvent) => {
      let parsed = null;

      try {
        parsed = JSON.parse(event.data);
      } catch (e) {}

      if (!parsed || typeof parsed !== "object") {
        console.error("websocket-connection", `Protocol violation. Handshake failed - malformed message`, event.data);

        resolver.reject();
        this.destroy();
      }

      if (parsed.spatialReference?.wkid !== spatialReference?.wkid) {
        console.error(          
            "websocket-connection",
            `Protocol violation. Handshake failed - expected wkid of ${spatialReference.wkid}`,
            event.data
        );
        resolver.reject();
        this.destroy();
      }

      if (parsed.format !== "json") {
        console.error(`websocket-connection`, `Protocol violation. Handshake failed - format is not set`, `${event.data}`);
        resolver.reject();
        this.destroy();
      }

      if (filter && parsed.filter !== filter) {
        console.error(new Error(`websocket-connection, Tried to set filter, but server doesn't support it`));
      }

      if (outFields && parsed.outFields !== outFields) {
        console.error(new Error(`websocket-connection, Tried to set outFields, but server doesn't support it`));
      }

      // Restore old handler
      websocket.onmessage = handler;
      resolver.resolve();
    };

    websocket.send(
      JSON.stringify({ filter, outFields, format: "json", spatialReference: { wkid: spatialReference.wkid } })
    );

    return resolver.promise;
  }

  protected _onMessage(event: MessageEvent): void {
    try {
      const parsed = JSON.parse(event.data) as {
        type: "featureResult";
        features: Feature[];
      };

      if (parsed.type !== "featureResult") {
        throw new Error(`websocket-connection, Protocol violation - Expected to find message of type 'featureResult', ${parsed}`);
      }

      for (const feature of parsed.features) {        
        this._onFeature(feature);        
      }
    } catch (e) {
      console.error("websocket-connection", "Failed to parse message", e);
      this.destroy();
      return;
    }
  }

  private _onError(_event: Event): void {
    const error = `Encountered an error over WebSocket connection`;
    this.errorString = error;
    console.error("websocket-connection", error);
  }

  private _onClose(event: CloseEvent): void {
    this._websocket = null;    

    if (event.code !== 1000) {
      console.error("websocket-connection", `WebSocket closed unexpectedly with error code ${event.code}`);
    }

    if (!this.destroyed) {
      this._open();
    }
  }
}