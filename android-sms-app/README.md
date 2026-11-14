# SpaxButchery SMS Companion (Android App)

A lightweight (~150 KB, zero-third-party-dependency) native Android companion app for **SpaxButchery Analytics**. It sends **separate personalized SMS messages in bulk** (`{firstname}`, `{name}`, `{spent}`, `{visits}`, `{days}`) directly through your phone's SIM card and regular Safaricom / Airtel SMS bundles — while keeping Google Messages as your default SMS app so customers can reply right in the same thread.

---

## 1. Build & Download the Ready-to-Install `.apk` on GitHub (No Laptop Needed)

A ready-to-use GitHub Actions workflow file is included at [`android-sms-app/github-workflow-android-sms-app.yml`](github-workflow-android-sms-app.yml):

1. On GitHub, tap **Add file → Create new file**, name it `.github/workflows/android-sms-app.yml`, paste the contents of `android-sms-app/github-workflow-android-sms-app.yml`, and tap **Commit changes** *(one-time step — GitHub requires a direct user commit to add workflow files)*.
2. Open the **Actions** tab → **Build Spax Android SMS App** → **Run workflow**.
3. Once green (~2 minutes), scroll down to **Artifacts** and download **`spax-sms-companion-apk`** (unzip to get `spax-sms-companion.apk`).
4. Tap `spax-sms-companion.apk` on your Android phone to install.

*(To build locally on a computer with JDK 17 + Android SDK instead, run `gradle -p android-sms-app assembleRelease`.)*

---

## 2. One-Time Phone Setup (Takes ~60 Seconds)

1. Open **Spax SMS** on your phone.
2. **Android 13 / 14 / 15 Restricted Settings step:**
   - Because the APK is installed directly (outside Google Play), Android initially locks the SMS permission until you confirm you trust it.
   - Tap **Grant Permissions** once. If Android blocks SMS, tap **App Settings** inside Spax SMS → tap the **⋮ (3 dots, top-right)** → tap **Allow restricted settings** → go back and tap **Grant Permissions** → **Allow**.
3. Tap **Allow Background Battery** ("Unrestricted") so ColorOS / Samsung / Xiaomi / Android never puts the app to sleep while your screen is locked during a 300+ recipient campaign.
4. Under **2. SIM Line & Safe Pacing**:
   - Choose **SIM 1 (e.g. Safaricom)** or **SIM 2 (e.g. Airtel)** on Dual-SIM phones.
   - Choose your pacing speed:
     - **Balanced Safe — 12s / SMS (Default):** ~65 minutes in the background for 326 recipients.
     - **Hands-Free 300+ — 32s / SMS:** stays strictly under Android's built-in 30-SMS-per-15-minutes prompt threshold so you never even have to tap an Android "Allow large SMS" popup while the phone is locked in your pocket.

---

## 3. Sending Personalized Bulk SMS from Outreach

1. Make sure your SIM has an active daily/weekly SMS bundle.
2. Open **SpaxButchery Analytics** → **Outreach**, pick your target segment (e.g. `🟡 Lapsing 31–60 days`) and template (`Hi {firstname}! We've missed you at SpaxButchery for {days} days. Are you ok?`).
3. Tap **`📲 Personalized Bulk SMS (Spax App)`**:
   - **Instant Local Bridge (when Spax SMS is running in the background):** Outreach pushes all 326 personalized messages over loopback (`127.0.0.1:8765`) in milliseconds and opens **Spax SMS** straight to your staged batch.
   - **Android Share Sheet (even if Spax SMS was closed):** Outreach opens Android's Share menu with the batch — tap **Spax SMS** and all 326 messages load immediately.
   - **File / Laptop-to-Phone Handoff:** You can also tap **📥 Download Batch (.json)** on a laptop, send the `.json` file to the shop phone, and open it with **Spax SMS**.
4. Review the preview & recipient count in **Spax SMS**, tap **`Start Sending`**, and lock your phone.

---

## Built-In Safety Protections

- **Never sends silently from a webpage:** The loopback bridge (`127.0.0.1:8765`) only *stages* batches from allowed origins and always requires your explicit tap on **Start Sending** inside the Android app.
- **Duplicate & Masked Filtering:** Masked numbers (`0723***321`), non-Kenyan numbers, and duplicate phone numbers in the same blast are skipped automatically.
- **Crash-Safe Resume (No Double-Texting):** Every recipient's status (`PENDING`, `SENT`, `DELIVERED`, `FAILED`, `UNKNOWN`) is saved atomically to disk. Pausing, resuming, or tapping **Retry Failed** never re-sends to customers already marked `SENT` or `UNKNOWN`.
- **Auto-Pause Circuit Breaker:** If 3 messages in a row fail (for example, your SMS bundle runs out mid-campaign), Spax SMS pauses automatically and alerts you so you can top up your bundle and tap **Retry Failed** + **Resume**.
