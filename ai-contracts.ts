-- 07:00 JST on Saturday and Sunday = 22:00 UTC on Friday and Saturday.
-- Requires a Vault secret named batch_secret.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'jra-weekend-daily-0700-jst',
  '0 22 * * 5,6',
  $job$
  select net.http_post(
    url := 'https://lgpvvwymvqzhoqkpuyjv.supabase.co/functions/v1/jra-weekend-daily',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-batch-secret', (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'batch_secret' limit 1
      )
    ),
    body := jsonb_build_object('scheduled_at', now()),
    timeout_milliseconds := 120000
  ) as request_id;
  $job$
);
