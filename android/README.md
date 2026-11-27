# PARTHAVI FOREX Android app

This Android application is a small native WebView shell for the existing hosted PARTHAVI FOREX dashboard. It does not copy, modify or execute the older PARTHAVI Trade Desk project.

## Dashboard

The app opens:

https://parthavi-forex-trade-desk-pro-2-0.onrender.com/

It keeps navigation inside that HTTPS dashboard origin. Other web links open outside the app. JavaScript and DOM storage are enabled because the dashboard is a web application; file/content access, cleartext HTTP and mixed content are disabled. The app does not add a JavaScript bridge or broker-order capability.

## Build a test APK

A GitHub Actions workflow builds a debug APK on pushes to `feature/native-android-shell`, or by manual workflow dispatch:

1. Open the repository's **Actions** tab.
2. Select **Build PARTHAVI FOREX Android app**.
3. Open a successful run and download the `parthavi-forex-debug-apk` artifact.
4. Extract it and install `app-debug.apk` on an Android device.

The debug APK is suitable for device testing. It is not a Play Store release and is signed with Android's debug signing key. A production release requires a private release keystore and protected signing secrets; no keystore or signing secret is stored in this repository.

## Live-data and prediction limitations

The app requires internet access for current quotes, candles, news and calendar data. It is not an offline trading terminal. The existing API's WAIT decision, independent-source checks, and probability-validation gates remain unchanged. This wrapper does not create signals, claim a win rate, or place broker orders.

The existing website PWA remains available and installable from Android Chrome independently of this native test wrapper.
