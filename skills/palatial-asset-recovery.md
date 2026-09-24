# Palatial asset recovery

When `palatial_get_asset` reports `PROCESSING_FAILED`, preserve the returned top-level `asset_id` as the canonical ID. Do not use a nested `details.id` unless the API explicitly identifies it as the asset ID.

A failed validation stage does not necessarily mean no package exists. Check export availability once. If a package is returned, label it as a partial or unvalidated export and explain the failed stage. If no package is returned, say so clearly. Failed-stage charges are refunded. Reprocessing charges only for remaining stages and requires user confirmation before starting.

Stop routine polling after a terminal failure. Show the failure reason, failed stage, dashboard link, and support path. Never create a replacement just to poll.
