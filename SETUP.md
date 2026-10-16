# Growth tracker on Google Sheets: setup

Do this once on a computer. It takes about 10 minutes. You need two files from this folder: `Code.gs` and `Index.html`.

## 1. Create the shared Sheet
1. Go to sheets.new and name the spreadsheet "Growth tracker".
2. Click **Share** and add your wife's Google account as **Editor**. Anyone you don't share it with can't read or change the data, even if they have the app link.
3. Copy the spreadsheet ID from the address bar. It is the long code between `/d/` and `/edit`.

## 2. Add the app to the Sheet
1. In the Sheet, open **Extensions › Apps Script**.
2. In `Code.gs`, delete everything and paste in the contents of `Code.gs` from this folder.
3. Replace `PASTE_SPREADSHEET_ID_HERE` with the ID you copied, keeping the quotes.
4. Click **+** next to *Files*, choose **HTML**, and name the file exactly `Index` (the editor adds `.html`). Delete its contents and paste in the contents of `Index.html`.
5. Click **Save**.

## 3. Publish it as a web app
1. Click **Deploy › New deployment**. Click the gear icon and choose **Web app**.
2. Set **Execute as** to **User accessing the web app**. This makes each of you read and write the Sheet as yourselves, so the Sheet's sharing decides who has access.
3. Set **Who has access** to **Anyone with Google account**.
4. Click **Deploy**, then **Authorize access**. Google will warn that it "hasn't verified this app". That is normal for a script you wrote yourself: click **Advanced**, then **Go to … (unsafe)**, then **Allow**.
5. Copy the **Web app URL**.

## 4. Put it on your phones
1. Open the web app URL in your phone's browser while signed in to Google. The first time, approve the same permission screen as above.
2. Add it to your home screen. On iPhone, tap **Share › Add to Home Screen** in Safari. On Android, tap **⋮ › Add to Home screen** in Chrome.
3. Send the URL to your wife so she can do the same.

## Bringing over existing data
In the Claude version, open **Settings › Save backup file**. Then, in the new app, open **Settings › Restore from backup file** and choose that file.

## Notes
- The Sheet has two tabs, *Children* and *Measurements*. You can read and edit them directly. Keep dates as YYYY-MM-DD, sex as `boy` or `girl`, and position as `lying` or `standing`.
- After changing the code, publish the update with **Deploy › Manage deployments ›** (pencil icon) **› Version: New version › Deploy**. Doing it this way keeps the same URL.
- Changes made on one phone appear on the other within about 30 seconds, or as soon as the app is reopened.
