import { Link } from "react-router";

export function ListViewScreen() {
  return (
    <div className="flex h-full flex-col bg-white p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Stops</h1>
        <Link to="/tracking-on-board" className="text-blue-600">
          Map View
        </Link>
      </div>
      <div className="mt-4 flex-1">{/* Stop list will go here */}</div>
    </div>
  );
}
