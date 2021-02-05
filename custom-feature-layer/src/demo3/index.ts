// Map data
import CustomFeatureLayer from './CustomFeatureLayer';

import ArcGISMap from "esri/Map";
import * as config from "esri/config";

// MapView
import MapView from 'esri/views/MapView';

const locationPath = location.href.replace(/\/[^\/]+$/, "../../../");
config.workers.loaderConfig = {
  packages: [
    {
      name: "app",
      location: locationPath + "dist/demo3"
    },
    {
      name: "common",
      location: locationPath + "dist/common"
    }
  ]
};

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
    title: "ID: {TRACKID}",
    content: "Type: {TYPE}\n Heading: {HEADING}"
  },
  effect: "drop-shadow(3px, 3px, 5px)"
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
      
    } else {
      layer.connect();     
    }
  });

  // update the UI
  layer.watch("connected", () => {
    if (layer.connected) {
      connectionButton.style.background='red';
      connectionButton.innerText = "Disconnect from service";
    } else {
      connectionButton.style.background = backgroundColor;
      connectionButton.innerText = "Connect to service";
    }
  });

  const showActiveCars = document.getElementById("showActiveButton");
  showActiveCars.style.background = backgroundColor;
  showActiveCars.addEventListener("click", () => {
    if (!layer.connected) {
      return;
    }

    if (layer.showActive) {
      showActiveCars.style.background = backgroundColor;
      showActiveCars.innerText = "Show active cars";
    } else {
      showActiveCars.style.background='red';
      showActiveCars.innerText = "Hide active cars";
    }

    layer.showActive = !layer.showActive;
  }); 
})

