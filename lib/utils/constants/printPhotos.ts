// Print-photos densities and their grid shapes. Mirrors the web client's
// PHOTOS_PER_PAGE_GRID (printPhotos.types.ts) so the server-rendered PDF
// matches the layout previewed in the Print Photos modal.
//
//   1/page      2/page       4/page        10/page
//   ┌───────┐   ┌───────┐    ┌───┬───┐     ┌───┬───┐
//   │       │   │       │    │   │   │     ├───┼───┤
//   │       │   ├───────┤    ├───┼───┤     ├───┼───┤
//   │       │   │       │    │   │   │     ├───┼───┤
//   └───────┘   └───────┘    └───┴───┘     └───┴───┘ (2 cols x 5 rows)

export interface IPhotosPerPageGrid {
  cols: number;
  rows: number;
}

export const PHOTOS_PER_PAGE_GRID: Record<number, IPhotosPerPageGrid> = {
  1: { cols: 1, rows: 1 },
  2: { cols: 1, rows: 2 },
  4: { cols: 2, rows: 2 },
  10: { cols: 2, rows: 5 },
};

export const PHOTOS_PER_PAGE_OPTIONS =
  Object.keys(PHOTOS_PER_PAGE_GRID).map(Number);

export const DEFAULT_PHOTOS_PER_PAGE = 2;

// Matches the client's PRINT_PHOTO_CAP: every photo is rendered full-resolution
// into the PDF, so the job size has to stay bounded.
export const PRINT_PHOTO_CAP = 50;

// Caption font size shrinks as density increases so it stays inside the cell.
export const PHOTO_CAPTION_FONT_SIZE: Record<number, number> = {
  1: 10,
  2: 9,
  4: 8,
  10: 6,
};
