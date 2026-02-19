import { Link } from "react-router";

export function TrackingOnBoardScreen() {
  return (
    <div className="flex h-full flex-col bg-white">
      <div className="flex-1 bg-gray-200">{/* Map will go here */}</div>
      <div className="p-6">
        <h2 className="text-lg font-bold">Tracking — On Board</h2>
        <p className="mt-1 text-gray-500">You're on the shuttle</p>
        <div className="mt-4 flex gap-3">
          <Link
            to="/list-view"
            className="flex-1 rounded-lg border border-gray-300 px-4 py-3 text-center"
          >
            List View
          </Link>
          <Link
            to="/get-off-reminder"
            className="flex-1 rounded-lg bg-blue-600 px-4 py-3 text-center text-white"
          >
            Set Reminder
          </Link>
        </div>
      </div>
    </div>
  );
}
