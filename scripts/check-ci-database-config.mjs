const password = process.env.POSTGRES_PASSWORD;
const value = process.env.DATABASE_URL;
if (!password || !value)
  throw new Error("CI database configuration is incomplete.");
let url;
try {
  url = new URL(value);
} catch {
  throw new Error("CI DATABASE_URL is invalid.");
}
if (
  url.protocol !== "postgresql:" ||
  url.hostname !== "127.0.0.1" ||
  url.port !== "5432" ||
  url.username !== "sculpin" ||
  url.password !== password ||
  url.pathname !== "/sculpin_hub"
) {
  throw new Error(
    "CI host database configuration does not match the Compose PostgreSQL service.",
  );
}
process.stdout.write(
  "CI host and Compose database configuration match (credentials redacted).\n",
);
