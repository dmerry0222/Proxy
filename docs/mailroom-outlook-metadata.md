# Outlook metadata ingestion

Mailroom normalizes high-confidence Outlook headers before AI triage. Power
Automate should continue writing the existing email fields and additionally map:

- `internetMessageHeaders` -> `emails.internet_message_headers`
- attachment objects, when available -> `emails.attachments`

Both columns accept the arrays returned by Outlook/Power Automate V3 directly.
Header names are matched case-insensitively by a database trigger, so every
writer receives the same normalization behavior.

The trigger populates calendar, automatic-reply, mailing-list, system-generated,
message-ID, list-ID, and meaningful-attachment fields. Do not map Outlook's
`hasAttachments` value into `has_real_attachments`; inline signatures and logos
are excluded using each attachment object's `isInline` value.

Mailroom loads only the normalized fields into classifier context. It does not
send the full Exchange header collection to the model. Calendar metadata routes
directly to the existing Calendar section, and automatic-only conversations
default to Low Value. Mailing-list status remains an AI input because list
content can be either Professional News or Low Value.

These routing decisions do not exclude messages from Memory ingestion.
