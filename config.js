/*
 * Global leaderboard settings (Supabase).
 *
 * Fill in both values to turn the leaderboard on; leave them empty and the game
 * keeps scores on each player's device only. See README.md for the setup steps.
 *
 * The publishable key is meant to be public: the database rules in
 * supabase/leaderboard.sql only let it read scores and add new ones.
 * Never put a secret key (sb_secret_...) or the service_role key here.
 */
window.LEADERBOARD = {
  supabaseUrl: 'https://vpsyvzxsqmyavwpagnxc.supabase.co',
  supabaseKey: 'sb_publishable_jRcRRGaaj-_5b390WQ-PLw_zEglHBOj'
};
