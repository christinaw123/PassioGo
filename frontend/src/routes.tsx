import { createBrowserRouter, Navigate } from "react-router";
import { DemoScreen } from "./components/screens/DemoScreen";
import { WelcomeScreen } from "./components/screens/WelcomeScreen";
import { ShuttleSelectionScreen } from "./components/screens/ShuttleSelectionScreen";
import { TrackingPreBoardScreen } from "./components/screens/TrackingPreBoardScreen";
import { TrackingOnBoardScreen } from "./components/screens/TrackingOnBoardScreen";
import { ListViewScreen } from "./components/screens/ListViewScreen";
import { GetOffReminderScreen } from "./components/screens/GetOffReminderScreen";

export const router = createBrowserRouter([
  {
    path: "/demo",
    Component: DemoScreen,
  },
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
    path: "/tracking-on-board",
    Component: TrackingOnBoardScreen,
  },
  {
    path: "/list-view",
    Component: ListViewScreen,
  },
  {
    path: "/get-off-reminder",
    Component: GetOffReminderScreen,
  },
  {
    path: "*",
    element: <Navigate to="/" replace />,
  },
]);
