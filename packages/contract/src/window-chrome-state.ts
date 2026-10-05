export interface WindowChromeState {
  mode: "overlay-pending" | "overlay" | "overlay-unavailable" | "native-frame";
  fullScreen: boolean;
  density: "comfortable" | "compact";
  toolbarHeight: number;
}
