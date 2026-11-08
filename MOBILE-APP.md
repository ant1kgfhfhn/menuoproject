# MENUO mobile app

The main branch is the single source of truth for the MENUO web application. Capacitor packages that same web source into the Android/iOS app; no separate application UI is maintained.

## Requirements

- Node.js 22 or newer
- Android Studio for local Android builds
- macOS with Xcode, or a compatible cloud macOS build service, for iOS builds

## Install and prepare

```bash
npm install
npm run build:mobile
npx cap add android
npx cap sync android
npx cap open android
```

To generate the iOS project on a compatible environment:

```bash
npx cap add ios
npx cap sync ios
npx cap open ios
```

Run `npm run cap:sync` after changes to the existing website files so the updated files are copied into the mobile web bundle.

## Important notes

- Keep mobile-specific build outputs (`www/`, `android/`, `ios/`) out of Git. Apply web changes on `main`, then run `npm run cap:sync` to rebuild the native bundle.
- The web bundle includes the existing MENUO UI, auth/backend scripts and legal pages.
- Before store submission, test Supabase authentication, file uploads, QR menu routes, discounts, account deletion and subscription/payment compliance on real devices.
- The iOS project must be built and signed with macOS/Xcode. Windows alone cannot produce the final signed App Store build.
- The bundle identifier is initially `com.menuo.app`; confirm it before first store submission because changing it later is inconvenient.
