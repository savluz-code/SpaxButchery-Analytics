# SpaxButchery Analytics

## The "new customer this month" tag

A customer who made their **first-ever purchase** in the current calendar
month (East Africa Time) carries a **🌱 New customer** tag. It shows on the
customer row in **Customers**, on the customer card, in the Outreach segment
table, in the masked-contacts table and in the drill-down lists behind the
Overview tiles.

The tag is **stored on the customer record** (`newMonth` — the month they were
tagged in), not merely worked out from a date, so it is **persistent for that
month**:

- importing another statement in the same month never clears it;
- a reload, a cloud pull, a cloud merge or a date repair never clears it —
  when two copies of a customer are merged, the **earliest** acquisition month
  either side knows wins, so a first visit that was rewritten cannot take the
  badge away;
- a record that lost its tag gets it back on the next load (the tag is
  restored from the customer's first visit).

The tag expires by itself on the 1st of the next month: the stored month stops
matching the current one. It is never cleared earlier than that.

## Outreach: new customer segments

Choose **New this week**, **New this month**, or **New (from…to)** in the
Outreach target segment. These filters use the customer’s first visit, not the
import date. The week runs Monday through today; the month runs from the first
through today, using East Africa Time. Custom dates are inclusive. Customers
without a known first-visit date or a reachable contact are excluded.

## Personalized bulk SMS

The Outreach tab has three SMS choices: a shared-message SMS app composer, a
one-at-a-time personalized queue, and **Send personalized bulk SMS**. The last
option submits a separately personalized message for each selected customer via
Africa's Talking. It requires a separately deployed gateway and an Africa's
Talking account; it does not work until the gateway is configured. Only send to
customers who have consented. SMS charges and sender-ID approval may apply.

### Set up the gateway

1. Create an Africa's Talking account, obtain an API key and username, and fund
   the account for live SMS. For a safe test, use its sandbox credentials and
   `AT_SANDBOX=1` (username is normally `sandbox`). Configure an approved sender
   ID if needed. The gateway sends to Kenyan mobile numbers only.
2. Deploy `sms-gateway/server.js` on a server running Node.js 18 or later. Expose
   it over HTTPS. This is a separate service: GitHub Pages and the existing
   Google Apps Script backend do not run Node servers. Configure these environment
   variables on the server (never put provider credentials in the HTML or Git):

   - `AT_USERNAME` and `AT_API_KEY`: provider credentials.
   - `SMS_GATEWAY_TOKEN`: a long, random secret, at least 32 characters (e.g.
     generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
   - `SMS_ALLOWED_ORIGIN`: exact origin of the app, e.g. `https://example.com`
     (no path or trailing slash). Only that browser origin is allowed.
   - Optional `AT_SENDER_ID`, `AT_SANDBOX=1`, and `PORT` (defaults to 3000).

   Start with `node sms-gateway/server.js`. Terminate TLS at the hosting
   platform/reverse proxy. Protect the token like a password, restrict who can
   access the service, and rotate it if exposed. The token authorizes chargeable
   sends; the origin check alone is not authentication. Consider additional
   rate limits and monitoring on the host. The service does not store messages
   or delivery history.
3. In Outreach, select recipients and edit the template. Enter the gateway URL
   ending in `/sms` and the gateway token, then confirm the campaign. The token
   is not saved; do not use a gateway you do not trust, since it receives the
   token, phone numbers and message contents. Preview personalized text and
   obtain consent before sending.

Each recipient receives a separate message using `{firstname}`, `{name}`,
`{spent}`, `{visits}`, and `{days}`. Invalid and duplicate numbers are skipped.
The result lists provider-accepted, rejected, unknown and not-attempted sends;
provider acceptance is **not** a delivery receipt. The campaign stops on an
unknown outcome or gateway configuration error. Check the provider's reports
before retrying an unknown message, and reselect only the intended recipients to
avoid duplicates. Closing or refreshing the page interrupts the campaign; its
progress is not persisted, so verify provider records before restarting. The
existing phone-composer options do not require this gateway.

Run regression tests with `node --test tests/*.test.js`.
