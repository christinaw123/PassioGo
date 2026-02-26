import { createBrowserRouter, Navigate } from "react-router";
import { WelcomeScreen } from "./components/screens/WelcomeScreen";
import { ShuttleSelectionScreen } from "./components/screens/ShuttleSelectionScreen";
import { TrackingPreBoardScreen } from "./components/screens/TrackingPreBoardScreen";

export const router = createBrowserRouter([
  {
    path: "/",
    Component: WelcomeScreen,
  },
  {
    path: "/shuttle-selection",
    Component: ShuttleSelectionScreen,
  },
  {
    path: "/tracking-pre-board",
    Component: TrackingPreBoardScreen,
  },
  {
    path: "*",
    element: <Navigate to="/" replace />,
  },
]);
