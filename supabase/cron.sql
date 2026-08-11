-- 07:00 JST every day = 22:00 UTC on the previous day.
-- The Edge Function exits after one race-list request when no JRA meeting exists.
-- Requires a Vault secret named batch_secret.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'jra-daily-0700-jst',
  '0 22 * * *',
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

-- Near-real-time result settlement every 3 minutes from 09:00 to 21:59 JST.
-- The function only fetches races that have started and are not yet finalized.
select cron.unschedule(jobid) from cron.job
where jobname = 'jra-results-live-10min';
select cron.schedule(
  'jra-results-live-3min',
  '*/3 0-12 * * *',
  $job$
  select net.http_post(
    url := 'https://lgpvvwymvqzhoqkpuyjv.supabase.co/functions/v1/jra-results-live',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-batch-secret', (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'batch_secret' limit 1
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $job$
);

-- Consume exactly one staged AI operation per minute. This stays below the
-- Gemini 5 RPM limit and lets failed stages retry without repeating successes.
select cron.schedule(
  'jra-prediction-worker-1min',
  '* * * * *',
  $job$
  select net.http_post(
    url := 'https://lgpvvwymvqzhoqkpuyjv.supabase.co/functions/v1/jra-prediction-worker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-batch-secret', (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'batch_secret' limit 1
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $job$
);
