import { declared, subclass, property } from "esri/core/accessorSupport/decorators";
import Layer from "esri/layers/Layer";
import CustomLayerView2D from "./CustomFeatureLayerView";

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
  //  Public properties
  //
  // --------------------------------------------------------------------------

  @property()
  connected: boolean = false;

  @property()
  showActive: boolean = false; 

  // --------------------------------------------------------------------------
  //
  //  Public methods
  //
  // --------------------------------------------------------------------------
  connect(): void {
    this.emit("connect");
  }

  disconnect(): void {
    this.emit("disconnect");
  }

  setConnected(isConnected: boolean): void {
    this.connected = isConnected;
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