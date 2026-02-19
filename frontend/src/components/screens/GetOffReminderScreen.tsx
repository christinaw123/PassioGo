import { Link } from "react-router";

export function GetOffReminderScreen() {
  return (
    <div className="flex h-full flex-col items-center justify-center bg-white p-6">
      <h1 className="text-xl font-bold">Get Off Reminder</h1>
      <p className="mt-2 text-center text-gray-500">
        We'll notify you when you're approaching your stop
      </p>
      <Link
        to="/tracking-on-board"
        className="mt-6 rounded-lg bg-blue-600 px-6 py-3 text-white"
      >
        Back to Map
      </Link>
    </div>
  );
}
