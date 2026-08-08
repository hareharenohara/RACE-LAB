# JRA AI競馬予想・収益検証 MVP

JRA中央競馬を対象に、3戦略（保守型・バランス型・積極型）の予想と仮想収支を検証する個人用Webアプリです。

## 構成

- `index.html` / `styles.css` / `ui.css` / `app.js`: Cloudflare Pages向けフロントエンド
- `supabase/schema.sql`: Supabaseデータベース定義とRLS
- `supabase/functions/_shared/jra-provider.ts`: JRAレース・出馬表・オッズ取得
- `supabase/functions/_shared/ai-contracts.ts`: Gemini出力の検証定義
- `supabase/functions/jra-weekend-daily/index.ts`: JRA開催日の取得・選定・予想バッチ
- `supabase/functions/jra-results-live/index.ts`: 着順・払戻取得と買い目の自動精算
- `supabase/cron.sql`: 毎日07:00 JSTの開催確認設定

## 運用

1. 毎日07:00に開催有無を確認し、土日・祝日などJRA開催日のみ予想します。
2. 開催なしの日はレース一覧の確認だけで終了し、Gemini APIは使用しません。
3. Geminiはレース選定1回と、戦略別予想3回の計4回を基本とします。
4. 各戦略は最大3レース、券種は7種類です。
5. 開始資金は各戦略10万円で、残高がマイナスでも検証を継続します。
6. 発走後の未確定レースを10分間隔で確認し、確定後に収支を反映します。

APIキー、Supabaseのsecret key、`BATCH_SECRET`はリポジトリへ保存しません。

## 現在の制約

- データ取得元は非公式エンドポイントのため、仕様変更時は取得処理の更新が必要です。
