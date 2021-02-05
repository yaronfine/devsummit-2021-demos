// Map data
import CustomFeatureLayer from './CustomFeatureLayer';

import ArcGISMap from "esri/Map";


// MapView
import MapView from 'esri/views/MapView';

const map = new ArcGISMap({
  basemap: "streets-navigation-vector"
});

const view = new MapView({
  container: 'viewDiv',
  map,
  center: [-118.2437, 34.0522],
  zoom: 10
});

const layer = new CustomFeatureLayer({
  popupTemplate: {
    title: "ID: {OBJECTID}",
    content: "Heading: {HEADING}<br>Type: {TYPE}"
  }
});
map.add(layer);

view.ui.add("topbar", "top-right");

layer.when(() => {
  const connectionButton = document.getElementById("connectionButton");
  const backgroundColor = connectionButton.style.background;
  connectionButton.addEventListener("click", () => {
    connectionButton.style.background = backgroundColor;
    if (layer.connected) {
      layer.disconnect();
      connectionButton.style.background = backgroundColor;
      connectionButton.innerText = "Connect to service";
    } else {
      layer.connect({
        filter: null as any,
        geometryType: "point",
        maxReconnectionAttempts: 100,
        maxReconnectionInterval: 10,       
        source: "ws://localhost:8000",
        sourceSpatialReference: {
          wkid: 102100
        },
        spatialReference: {
          wkid: 102100
        }
      }, (status: string) => {
        if (status === "connected") {
          connectionButton.style.background='red';
          connectionButton.innerText = "Disconnect from service";
        }
      });      
    }
  });
})

