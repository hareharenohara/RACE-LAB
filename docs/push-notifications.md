# 的中結果のWeb Push通知

結果取得処理が払戻額を確認し、払戻が1円以上あるレースだけを通知します。外れ、予想開始、購入時には通知しません。同じ端末・同じレースへの二重送信はDBで防止します。

## 初回設定

1. VAPID鍵ペアを生成する（秘密鍵はリポジトリへ保存しない）。
2. SupabaseのEdge Function secretsへ次を登録する。
   - `VAPID_PUBLIC_KEY`
   - `VAPID_PRIVATE_KEY`
   - `VAPID_SUBJECT`（例: `mailto:admin@example.com`）
3. `20260815093000_add_push_notifications.sql` を適用する。
4. `push-config` と `jra-results-live` をデプロイする。

公開鍵は `push-config` がブラウザへ返します。秘密鍵は `jra-results-live` の署名にのみ使われます。

## 利用方法

ログイン後、ダッシュボードの「通知を受け取る」を押してブラウザの通知を許可します。通知をタップすると、そのレースの結果カードへ移動します。iPhone/iPadではホーム画面へ追加したWebアプリから許可してください。
