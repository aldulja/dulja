# Malaysia tax pack

Only the synthetic `SYNTH-MY-v1` regime ships. Its rates and return boxes are invented test data and must not be used for statutory filing.

Apply the chart first, then `seed --only tax`. Existing regime and rate rows are not overwritten. A changed rate is a new effective-dated row in a reviewed seed change.

The seed reads `APP_ENV` from its own environment as the API does (unset is `dev`, and the CLI prints a warning saying so; anything but `dev`, `staging` or `production` is a configuration error, exit 2). With `APP_ENV=production` the loader skips every regime whose `source` begins with `SYNTHETIC`, inserts none of its codes, and lists the file under `skipped` in the seed's printed result; a regime whose source is not synthetic loads as usual. `dev` and `staging` load `SYNTH-MY-v1`. A production seed must therefore run as `APP_ENV=production bun run seed …` (`docs/runbooks/deploy.md`); without it, it is a dev seed.

OD-15 requires the current authority publication and the accountant's confirmation before a verified regime and its corresponding pure return definition can be added under ADR 0049.
