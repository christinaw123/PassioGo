interface BottomSheetProps {
  children: React.ReactNode;
  height?: string;
}

export function BottomSheet({ children, height = "45%" }: BottomSheetProps) {
  const isAuto = height === "auto";

  return (
    <div
      className="absolute bottom-0 left-0 right-0 z-20 rounded-t-3xl bg-white shadow-[0_-4px_20px_rgba(0,0,0,0.1)]"
      style={{
        height: isAuto ? "auto" : height,
        maxHeight: isAuto ? "85vh" : undefined,
      }}
    >
      {/* Drag handle */}
      <div className="flex justify-center pt-3 pb-2">
        <div className="h-1 w-10 rounded-full bg-gray-300" />
      </div>
      <div
        className="overflow-y-auto px-6 pb-10"
        style={
          isAuto
            ? { maxHeight: "calc(85vh - 24px)" }
            : { height: "calc(100% - 24px)" }
        }
      >
        {children}
      </div>
    </div>
  );
}
