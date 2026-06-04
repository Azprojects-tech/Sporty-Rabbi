# Security Rotation Checklist

Use this checklist whenever an API key/token may be exposed or during scheduled rotation.

## 1) Prepare
- Identify secrets to rotate: `API_FOOTBALL_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `TWILIO_AUTH_TOKEN`, Firebase credentials.
- Notify team of maintenance window.
- Confirm `.env` files are ignored by git.

## 2) Rotate at provider
- Generate new key/token in provider dashboard.
- Revoke old key/token after rollout verification.
- For Twilio, rotate Auth Token from Twilio Console and confirm WhatsApp sender remains valid.

## 3) Update environments
- Local: update `backend/.env` and `frontend/.env`.
- Railway/Netlify: update environment variables in dashboard.
- Firebase: rotate service account key if needed and replace secret mount.

## 4) Verify
- Start backend and frontend.
- Check `/api/health`.
- Trigger one analysis request and one alert path.
- Confirm no auth/403/401 errors in logs.

## 5) Post-rotation checks
- Confirm old credentials are revoked.
- Clear any leaked values from shell history and shared notes.
- Record date, owner, and rotated items in an internal log.

## 6) If leak suspected
- Rotate immediately (do not wait for schedule).
- Temporarily disable affected integration if abuse is detected.
- Review logs for unusual usage during exposure window.
