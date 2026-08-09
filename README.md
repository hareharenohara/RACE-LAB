# JRA AI競馬予想・収益検証 MVP

JRA中央競馬を対象に、単一AIが全36レースを段階分析して買い目を最終決定する個人用Webアプリです。

## 構成

- `index.html` / `styles.css` / `ui.css` / `app.js`: Cloudflare Pages向けフロントエンド
- `supabase/schema.sql`: Supabaseデータベース定義とRLS
- `supabase/functions/_shared/jra-provider.ts`: JRAレース・出馬表・オッズ取得
- `supabase/functions/_shared/ai-contracts.ts`: Gemini出力の検証定義
- `supabase/functions/jra-weekend-daily/index.ts`: JRA開催日の全レース取得
- `supabase/functions/jra-prediction-worker/index.ts`: 単一AIの段階分析・買い目決定ワーカー
- `supabase/functions/jra-results-live/index.ts`: 着順・払戻取得と買い目の自動精算
- `supabase/cron.sql`: 毎日07:00 JSTの開催確認設定

## 運用

1. 毎日07:00に開催有無を確認し、土日・祝日などJRA開催日のみ予想します。
2. 開催なしの日はレース一覧の確認だけで終了し、Gemini APIは使用しません。
3. Geminiは一次分析4回、統合1回、詳細分析2回、提案1回、最終判断1回の計9回を基本とします。
4. AIは券種・組み合わせ・金額・全見送りを自分で決定します。
5. 開始資金は10万円、1日予算は1万円、最低購入額は1点500円です。
6. 発走後の未確定レースを10分間隔で確認し、確定後に収支を反映します。

APIキー、Supabaseのsecret key、`BATCH_SECRET`はリポジトリへ保存しません。

## 現在の制約

- データ取得元は非公式エンドポイントのため、仕様変更時は取得処理の更新が必要です。
