# DreamLive Final

## Render environment variables

Required (at least one provider):
- API_FOOTBALL_KEY = API-Football application key
- FOOTBALL_DATA_TOKEN = football-data.org token

Optional:
- ADMIN_UPLOAD_TOKEN = secret token for video uploads
- GA_MEASUREMENT_ID = Google Analytics measurement ID (hook for future use)
- CACHE_DIR = persistent path for fallback cache (recommended if a Render persistent disk is attached)
- UPLOADS_DIR = persistent path for uploaded videos (recommended if a Render persistent disk is attached)

## Render
Build: `npm install`
Start: `npm start`

## Notes
The app keeps a disk-backed cache fallback. Render's default filesystem is ephemeral, so to persist the last successful data and uploaded videos across redeploys/restarts, attach a persistent disk or use a managed datastore/object storage.
