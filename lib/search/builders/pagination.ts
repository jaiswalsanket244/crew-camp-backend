// ES rejects searches whose `from + size` exceeds max_result_window (default 10000); paginationWindow() clamps out-of-range pages to zero/partial hits so the ES path mirrors Mongo's empty deep pages instead of throwing. Keep MAX_RESULT_WINDOW in sync if a mapping ever overrides the default.
export const MAX_RESULT_WINDOW = 10000;

// Clamps an already-computed from/size pair. Needed because the pinned-row splice shifts the
// unpinned offset by the pin count, so `from` is NOT a multiple of `size` and cannot be
// expressed as a (page, pageSize) pair.
export const clampWindow = (
  from: number,
  size: number,
): { from: number; size: number } => {
  if (from >= MAX_RESULT_WINDOW) {
    return { from: 0, size: 0 };
  }
  if (from + size > MAX_RESULT_WINDOW) {
    return { from, size: MAX_RESULT_WINDOW - from };
  }
  return { from, size };
};

export const paginationWindow = (
  page: number,
  pageSize: number,
): { from: number; size: number } =>
  clampWindow((page - 1) * pageSize, pageSize);
