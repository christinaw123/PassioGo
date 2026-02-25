// ─── Layout knobs ────────────────────────────────────────────────────────────
/** Horizontal padding inside the sheet — controls effective content width, in px */
const SHEET_PADDING_X = 24;      // try: 12  16  20  24  32
/** Bottom padding inside the sheet, in px */
const SHEET_PADDING_BOTTOM = 40; // try: 24  32  40  48
/** Top corner radius of the sheet, in px */
const SHEET_TOP_RADIUS = 24;     // try: 12  16  20  24  32
// ─────────────────────────────────────────────────────────────────────────────

interface BottomSheetProps {
  children: React.ReactNode;
  height?: string;
}

export function BottomSheet({ children, height = "45%" }: BottomSheetProps) {
  const isAuto = height === "auto";

  return (
    <div
      className="absolute bottom-0 left-0 right-0 z-20 bg-white shadow-[0_-4px_20px_rgba(0,0,0,0.1)]"
      style={{
        height: isAuto ? "auto" : height,
        maxHeight: isAuto ? "85vh" : undefined,
        borderTopLeftRadius: SHEET_TOP_RADIUS,
        borderTopRightRadius: SHEET_TOP_RADIUS,
      }}
    >
      {/* Drag handle */}
      <div className="flex justify-center pt-3 pb-2">
        <div className="h-1 w-10 rounded-full bg-gray-300" />
      </div>
      <div
        className="overflow-y-auto"
        style={{
          paddingLeft: SHEET_PADDING_X,
          paddingRight: SHEET_PADDING_X,
          paddingBottom: SHEET_PADDING_BOTTOM,
          ...(isAuto
            ? { maxHeight: "calc(85vh - 24px)" }
            : { height: "calc(100% - 24px)" }),
        }}
      >
        {children}
      </div>
    </div>
  );
}
