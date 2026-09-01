// ============================================================
// Guess the Road — game configuration
// Edit these values and just refresh the page. No rebuild needed.
// ============================================================
window.GAME_CONFIG = {

  // --- Data file ---
  DATA_FILE: "https://pbmovcviwrymkanyrglh.supabase.co/storage/v1/object/public/geojson/roads.geojson",

  // --- Scoring ---
  STARTING_POINTS: 10000,
  COST_NORTH_SOUTH_QUESTION: 100,
  COST_EAST_WEST_QUESTION: 100,
  COST_M3_QUESTION: 250,
  COST_WRONG_GUESS: 1000,

  // --- Target selection ---
  MIN_TARGET_LENGTH_M: 300,

  // --- M3 boundary ---
  M3_ROAD_NAMES: ["Eastern Freeway", "Alexandra Parade"],

  // --- Map ---
  MAP_CENTER: [145.0, -37.85],
  MAP_ZOOM: 10.2,
  MAP_STYLE: "https://tiles.openfreemap.org/styles/liberty",
};

// ============================================================
// Supabase project settings.
// Create a free project at https://supabase.com, then paste:
//   Project Settings -> API -> Project URL        -> SUPABASE_URL
//   Project Settings -> API -> anon public key     -> SUPABASE_ANON_KEY
// These are safe to expose client-side (RLS policies protect the data).
// ============================================================
window.SUPABASE_CONFIG = {
  URL: "https://pbmovcviwrymkanyrglh.supabase.co",
  ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBibW92Y3Zpd3J5bWthbnlyZ2xoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyMjE1MTUsImV4cCI6MjEwMzc5NzUxNX0.Dd5w9bVreE8CQRBYUe_VjZxyKt6-Q2ZJxIY7nlyOvbM",
};
