# Discord Status Webhook

ส่งเหตุขัดข้องและประกาศใหม่จาก [Discord Status](https://discordstatus.com/) ไปยัง Discord Webhook รองรับ Render, Docker และ health check ที่ `/health`

## ใช้งานในเครื่อง

ต้องมี Node.js 20 ขึ้นไป

```bash
cp .env.example .env
```

ใส่ Webhook URL ใน `.env`:

```env
URL_WEBHOOK=https://discord.com/api/webhooks/WEBHOOK_ID/WEBHOOK_TOKEN
UPSTASH_REDIS_REST_URL=https://DATABASE.upstash.io
UPSTASH_REDIS_REST_TOKEN=YOUR_TOKEN
```

```bash
npm run test:webhook  # ทดสอบ Webhook
npm run test:database # ทดสอบ Upstash โดยไม่ทิ้งข้อมูล
npm start             # เริ่มทำงาน
```

ค่าตั้งค่าเพิ่มเติมดูได้ใน `.env.example` โปรแกรมตรวจทุก 15 วินาทีและใช้ Upstash 100% พร้อม atomic lock ป้องกันหลาย instance แจ้งซ้ำ ค่า `none` หรือข้อมูลที่ API ไม่ส่งมาจะแสดงว่า “ไม่ทราบ” โดยไม่คาดเดา

สี Embed แยกตามสถานะ: Investigating แดง, Identified/In progress ส้ม, Monitoring ฟ้า, Resolved/Completed เขียว, Verifying ฟ้าอมเขียว, Scheduled น้ำเงิน, Postmortem ม่วง และสถานะอื่นสีเทา

## Deploy บน Render

1. ที่ Render เลือก **New → Blueprint**
2. ใช้ repository [haidarat/discordstatus-webhook](https://github.com/haidarat/discordstatus-webhook.git):

   ```text
   https://github.com/haidarat/discordstatus-webhook.git
   ```

3. กำหนด `URL_WEBHOOK`, `UPSTASH_REDIS_REST_URL` และ `UPSTASH_REDIS_REST_TOKEN`
4. Deploy แล้วตรวจ `https://ชื่อบริการ.onrender.com/health`

## cron-job.org

สร้าง cron job เพื่อเรียก Render ทุก 5 นาที เพื่อไม่ให้ Free service หลับ:

```text
URL: https://ชื่อบริการ.onrender.com/health
Method: GET
Schedule: Every 5 minutes
```

ห้ามใส่ Webhook URL หรือ Upstash Token ลงใน GitHub ให้เก็บเป็น Environment Variables ของ Render เท่านั้น

ควรมี Render service ที่ใช้ Webhook นี้เพียงตัวเดียว หากเคย Deploy ซ้ำหลาย service ให้ลบตัวเก่าหรือสร้าง Webhook URL ใหม่ มิฉะนั้นโปรแกรมเก่าที่ยังทำงานอยู่สามารถส่งข้อความซ้ำได้

## Docker

```bash
docker compose up -d --build
```

## ทดสอบ

```bash
npm test
```
