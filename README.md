# JRA AI競馬予想・収益検証 MVP

JRA中央競馬を対象に、3戦略（保守型・バランス型・積極型）の予想と仮想収支を検証する個人用Webアプリです。

## 構成

- `index.html` / `styles.css` / `ui.css` / `app.js`: Cloudflare Pages向けフロントエンド
- `supabase/schema.sql`: Supabaseデータベース定義とRLS
- `supabase/functions/_shared/jra-provider.ts`: JRAレース・出馬表・オッズ取得
- `supabase/functions/_shared/ai-contracts.ts`: Gemini出力の検証定義
- `supabase/functions/jra-weekend-daily/index.ts`: 土日朝のJRA取得・選定・予想バッチ
- `supabase/cron.sql`: 土日07:00 JSTの自動実行設定

## 運用

1. 土曜分は土曜07:00、日曜分は日曜07:00に取得します。
2. Geminiはレース選定1回と、戦略別予想3回の計4回を基本とします。
3. 各戦略は最大3レース、券種は7種類です。
4. 開始資金は各戦略10万円で、残高がマイナスでも検証を継続します。

APIキー、Supabaseのsecret key、`BATCH_SECRET`はリポジトリへ保存しません。

## 現在の制約

- JRAの結果取得と自動精算は未実装です。
- データ取得元は非公式エンドポイントのため、仕様変更時は取得処理の更新が必要です。
