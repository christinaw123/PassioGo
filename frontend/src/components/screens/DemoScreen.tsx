import { useState, useEffect } from "react";
import { useNavigate } from "react-router";
import { QRCodeSVG } from "qrcode.react";

export function DemoScreen() {
  const navigate = useNavigate();
  const [appUrl, setAppUrl] = useState("");
  const isLocalhost =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1");

  useEffect(() => {
    // Point QR to the main app route on the same host
    setAppUrl(`${window.location.origin}/`);
  }, []);

  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center bg-gray-950 px-6 text-center">
      {/* Title */}
      <div className="mb-10">
        <h1 className="mb-2 text-3xl font-bold text-white">Harvard Shuttle</h1>
        <p className="text-lg text-gray-400">
          Scan the QR code to open on your phone
        </p>
      </div>

      {/* QR code */}
      {appUrl && (
        <div className="rounded-3xl bg-white p-6 shadow-2xl">
          <QRCodeSVG
            value={appUrl}
            size={240}
            level="M"
            marginSize={0}
          />
        </div>
      )}

      {/* URL display */}
      <p className="mt-6 rounded-xl bg-gray-800 px-4 py-2 font-mono text-sm text-gray-300">
        {appUrl}
      </p>

      {/* Localhost warning */}
      {isLocalhost && (
        <p className="mt-4 max-w-xs text-sm text-amber-400">
          You're on localhost — open this page using your local network IP
          (e.g. 192.168.x.x:{window.location.port}) so others can scan the QR
          code.
        </p>
      )}

      {/* Enter button */}
      <button
        onClick={() => navigate("/")}
        className="mt-10 cursor-pointer rounded-2xl bg-blue-600 px-10 py-4 text-lg font-medium text-white shadow-lg transition-colors hover:bg-blue-700"
      >
        Enter App
      </button>
    </div>
  );
}
