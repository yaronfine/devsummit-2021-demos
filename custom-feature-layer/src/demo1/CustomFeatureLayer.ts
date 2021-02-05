import { declared, subclass } from "esri/core/accessorSupport/decorators";
import Layer from "esri/layers/Layer";
import CustomLayerView2D from "./CustomFeatureLayerView";
import { Feature, WebSocketConnection, IWebSocketConnectionConfig } from "../common/WebSocetConnection";

@subclass("CustomFeatureLayer")
export default class CustomFeatureLayer extends declared(Layer) {
  // --------------------------------------------------------------------------
  //
  //  Life cycle
  //
  // --------------------------------------------------------------------------

  constructor(params?: any) {
    super(params);    
  }

  destroy(): void {
    this.disconnect();
  }

  // --------------------------------------------------------------------------
  //
  //  Private properties
  //
  // --------------------------------------------------------------------------

  private _connection: WebSocketConnection;
  
  // --------------------------------------------------------------------------
  //
  //  Public properties
  //
  // --------------------------------------------------------------------------

  get connected(): boolean {
    return this._connection && this._connection.connectionStatus === "connected";
  }

  // --------------------------------------------------------------------------
  //
  //  Public methods
  //
  // --------------------------------------------------------------------------
  connect(config: IWebSocketConnectionConfig, onConnectionStatusChange: (status: string) => void) {
    if (this.connected) {
      this._connection.destroy();
    }

    this._connection = new WebSocketConnection(config, (feature: Feature) => this.emit("onFeature", feature), onConnectionStatusChange);
  }

  disconnect(): void {
    if (this.connected) {
      this._connection.destroy();
    }
  }

  createLayerView(view: any): any {
    if (view.type === "2d") {
      return new CustomLayerView2D({
        view,
        layer: this
      } as any);
    }
  }
}