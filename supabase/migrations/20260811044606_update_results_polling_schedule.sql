select cron.unschedule(jobid)
from cron.job
where jobname in ('jra-results-live-10min', 'jra-results-live-3min');

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
