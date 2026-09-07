1. Overview & Product Vision

1.1 Product Overview

DailyPilot یک اپلیکیشن وب فارسی (RTL) با قابلیت نصب به صورت PWA است که هدف آن کمک به کاربران برای برنامه‌ریزی واقع‌بینانه روزانه بر اساس ظرفیت واقعی زمانی است.

برخلاف ابزارهای سنتی مدیریت Task که صرفاً فهرستی از کارها ایجاد می‌کنند، DailyPilot بر اساس مفهوم Time Budget Planning طراحی شده است.

در این مدل:

کاربر ظرفیت زمانی قابل استفاده خود در روز را مشخص می‌کند (availableMinutes)

سیستم Taskهای موجود را تحلیل می‌کند

با استفاده از AI میزان اهمیت، زمان موردنیاز و اولویت هر Task را مشخص می‌کند

موتور برنامه‌ریزی (Rebalance Engine) وظایف را در محدوده زمانی واقعی روز تخصیص می‌دهد

هدف اصلی سیستم ایجاد یک برنامه قابل اجرا است، نه یک لیست ایده‌آل اما غیرواقعی.

بخش ۲ — Core Features + Design Principles

این بخش قابلیت‌های اصلی DailyPilot و اصول معماری حاکم بر آن را مشخص می‌کند.

هدف این سند این است که مشخص شود هر قابلیت چه مسئولیتی دارد، چه وابستگی‌هایی دارد و چه تصمیم‌هایی برای جلوگیری از پیچیده شدن آینده گرفته شده است.

اصول حاکم بر طراحی DailyPilot

1. Task هرگز به AI وابسته نیست

AI یک قابلیت افزوده روی Task است، نه بخشی از ماهیت Task.

ساخت یک Task باید همیشه امکان‌پذیر باشد، حتی اگر:

سرویس AI در دسترس نباشد

کاربر پلن رایگان داشته باشد

کاربر نخواهد از AI استفاده کند

بنابراین:

Task Creation ≠ AI Analysis

ساخت Task باید سریع، ساده و مستقل باشد.

جریان صحیح:

مرحله اول:

User creates Task

↓

Task saved

مرحله دوم (اختیاری):

User requests AI Analysis

↓

AI adds:

- score

- priority

- estimatedTime

- category

- reason

نتیجه معماری

AI یک لایه تحلیل‌گر روی Task است، نه موتور اصلی محصول.

در آینده امکان دارد:

AI رایگان محدود شود

مدل تغییر کند

Provider عوض شود

قابلیت AI تبدیل به ویژگی پولی شود

بدون اینکه ساختار اصلی Task آسیب ببیند.

2. مفهوم روز کاربر

روز در DailyPilot بر اساس زمان محلی خود کاربر تعریف می‌شود.

قانون اصلی:

روز منطقی کاربر = روز محلی در timezone خودش

تقویم فقط یک لایه نمایش است.

مثلاً:

کاربر ایرانی مقیم آلمان:

timezone:

Europe/Berlin

calendar:

JALALI

locale:

fa

یعنی:

ساعت بر اساس آلمان محاسبه می‌شود

نمایش تاریخ می‌تواند شمسی باشد

زبان فارسی باقی می‌ماند

User باید شامل:

timezone

locale

calendar

باشد.

این سه مفهوم نباید با هم ترکیب شوند.

3. Rebalance Engine

مسئولیت

Rebalance Engine وظیفه دارد Taskها را بر اساس ظرفیت واقعی روز کاربر تخصیص دهد.

هدف:

تبدیل لیست Taskها به یک برنامه واقعی قابل انجام.

نسخه فعلی (v1)

در نسخه اول، موتور از یک مدل وزن‌دهی استفاده می‌کند.

ورودی:

Tasks

+

Available Daily Time

+

AI Score

+

Estimated Time

خروجی:

Task Allocation

فرمول فعلی تخصیص

وزن هر Task:

weight =

estimatedTime × (0.5 + score / 200)

توضیح اجزای فرمول

Estimated Time

زمان تخمینی نشان می‌دهد Task چه مقدار ظرفیت نیاز دارد.

مثال:

Task A

estimatedTime:

120 دقیقه

این Task نسبت به Task کوتاه‌تر سهم بیشتری از زمان دریافت می‌کند.

Score

امتیاز AI بین ۰ تا ۱۰۰ اهمیت Task را مشخص می‌کند.

مثال:

Task A:

score = 90

Task B:

score = 40

Task A وزن بیشتری خواهد داشت.

مثال:

ظرفیت روز:

300 دقیقه

Taskها:

Task A

estimatedTime:

120

score:

90

Task B

estimatedTime:

60

score:

50

محاسبه:

Task A:

120 × (0.5 + 90/200)

=

114

Task B:

60 × (0.5 + 50/200)

=

45

بنابراین Task A سهم بیشتری از زمان روز دریافت می‌کند.

قوانین تکمیلی Rebalance v1

حفظ Task در حال انجام

Task با وضعیت:

IN_PROGRESS

اولویت بیشتری دارد.

موتور نباید به راحتی زمان آن را کاهش دهد.

حداقل تخصیص

اگر سهم یک Task کمتر از:

15 دقیقه

شود، این تخصیص منطقی محسوب نمی‌شود و می‌تواند کاندید rollover شود.

گرد کردن زمان

تمام تخصیص‌ها به مضرب ۵ دقیقه گرد می‌شوند.

مثال:

47 دقیقه

↓

45 دقیقه

محدودیت‌های مدل فعلی

فرمول فعلی عمداً ساده طراحی شده است.

در نسخه فعلی موارد زیر لحاظ نمی‌شوند:

ساعت مشخص انجام Task

جلسه‌های ثابت

زمان‌های تمرکز

سطح انرژی کاربر

وابستگی بین Taskها

مسیر توسعه آینده

در آینده Rebalance Engine باید از یک فرمول ساده به یک Scheduling Engine تبدیل شود.

مدل آینده:

Tasks

+

Constraints

+

Calendar Events

+

User Preferences

+

Energy Pattern

+

AI Suggestions

↓

Scheduling Engine

↓

Daily Plan

اصل معماری Rebalance

Rebalance نباید به یک فرمول خاص وابسته باشد.

قرارداد اصلی:

Input:

Tasks

+

Constraints

+

Available Time

Output:

Task Allocation

فرمول فعلی فقط پیاده‌سازی نسخه اول است.

4. مدیریت Task

وضعیت فعلی

Task قابلیت‌های زیر را دارد:

ایجاد

حذف

مشاهده لیست روزانه

تغییر وضعیت

تکمیل

اطلاعات اصلی Task:

title

status:

TODO

IN_PROGRESS

DONE

scheduledDate

ویرایش Task

تصمیم معماری

کاربر باید بتواند Task را بدون اجرای دوباره AI ویرایش کند.

دلیل:

تغییر متن Task همیشه به معنی نیاز به تحلیل جدید نیست.

مثال:

Task:

خواندن کتاب

کاربر تغییر می‌دهد:

خواندن فصل سوم کتاب Clean Code

این همان Task است، فقط جزئیات بیشتری پیدا کرده است.

اما:

اگر کاربر Task را کاملاً تغییر دهد:

خواندن کتاب

↓

رزرو بلیت سفر

این در واقع یک Task جدید است.

قانون:

ویرایش Task نباید به صورت خودکار باعث مصرف AI شود.

AI فقط زمانی اجرا می‌شود که:

کاربر درخواست کند

سیستم تشخیص دهد نیاز به تحلیل جدید وجود دارد

5. تحلیل Task توسط AI

AI خروجی ساختاریافته تولید می‌کند:

{

score,

priority,

estimatedTime,

category,

reason

}

نقش AI در نسخه اول:

AI:

پیشنهاد می‌دهد

تحلیل می‌کند

توضیح می‌دهد

اما:

تصمیم نهایی با:

کاربر

موتور برنامه‌ریزی

است.

6. Priority System

دو مفهوم جدا وجود دارد:

Score

عدد:

0 - 100

برای محاسبات داخلی و موتور تخصیص.

Priority

نمایش ساده برای کاربر:

HIGH

MEDIUM

LOW

این دو نباید با هم یکی شوند.

7. Time Estimation

AI زمان تخمینی Task را تولید می‌کند:

estimatedTime

این مقدار:

زمان قطعی نیست

فقط تخمین اولیه است

برای تخصیص ظرفیت استفاده می‌شود

8. Time Tracking

DailyPilot فقط برنامه نمی‌دهد، بلکه واقعیت را اندازه می‌گیرد.

ثبت:

spentMinutes

نتیجه:

زمان مصرف شده

زمان ذخیره شده

بیش مصرفی

تاریخچه عملکرد

9. مدیریت Taskهای عقب افتاده

وضعیت فعلی:

مشاهده Taskهای overdue

انتقال Task به روز جدید

تخصیص مجدد

نسخه فعلی:

Manual rollover

است.

اتوماسیون:

Cron / Background Job

برای آینده است.

10. Event Log

برای ساخت قابلیت‌های آینده مثل:

مربی هوشمند زمان

تحلیل رفتار کاربر

پیشنهادهای شخصی

نیاز به تاریخچه داریم.

مدل پیشنهادی:

TaskEvent

{

taskId

type:

CREATED

ANALYZED

ROLLED_OVER

COMPLETED

createdAt

}

11. مدل درآمدی

فعلاً ساده نگه داشته می‌شود.

روی User:

plan:

FREE

PRO

فعلاً ساخته نمی‌شود:

Subscription

Payment

Invoice

Usage Tracking

تا زمانی که محصول اعتبارسنجی نشده است.

12. Habit Building

قابلیت آینده:

ساخت عادت

پیگیری استمرار

اتصال Task به رفتارهای روزانه

در نسخه فعلی جزو Core Feature نیست.

جمع‌بندی تصمیم‌های قطعی بخش ۲

Task مستقل از AI است.

AI یک قابلیت اختیاری و قابل پولی شدن است.

ویرایش Task نیازمند تحلیل مجدد اجباری نیست.

Rebalance Engine یک قرارداد است، نه یک فرمول ثابت.

فرمول فعلی:

weight =

estimatedTime × (0.5 + score / 200)

فقط نسخه اول موتور است.
6. روز کاربر بر اساس timezone خودش تعریف می‌شود.
7. تقویم فقط لایه نمایش است.
8. AI پیشنهاددهنده است، نه تصمیم‌گیرنده.
9. تاریخچه رفتار کاربر برای قابلیت‌های آینده باید حفظ شود.

3. System Architecture

3.0 ماهیت معماری: یک مونولیت لایه‌ای

DailyPilot یک Next.js App Router Monolith است؛ یعنی Frontend و Backend به‌صورت دو پروژه جداگانه نیستند، بلکه در یک application قرار دارند و داخل آن مرزهای لایه‌ای مشخصی تعریف شده است.

هدف این معماری، ایجاد مرز روشن بین Presentation، HTTP/API، Business Logic، Database و External Services است تا تغییر یا توسعه هر بخش کمترین وابستگی ممکن را به سایر بخش‌ها داشته باشد.

Server Components

Server Components، از جمله layoutها و صفحات Dashboard، می‌توانند مستقیماً از Service/Business Logic و Prisma برای خواندن داده استفاده کنند.

احراز هویت در سمت سرور انجام می‌شود؛ برای مثال:

dashboard/layout.tsx → getCurrentUser

Server Components برای خواندن داده مجبور نیستند از HTTP API داخلی عبور کنند، زیرا این کار در داخل همان application انجام می‌شود و ایجاد یک HTTP hop غیرضروری است.

Client Components

Client Components در components/ و contexts/ مسئول UI، interaction و state سمت کلاینت هستند.

Client Components:

مستقیماً به Prisma دسترسی ندارند.

به envهای محرمانه دسترسی ندارند.

secret یا API key را دریافت نمی‌کنند.

برای عملیات سمت سرور از Route Handlerهای API استفاده می‌کنند.

Route Handlers

Route Handlerها در app/api/*/route.ts مرز HTTP/API سیستم هستند.

قانون هدف:

Route Handler باید Thin باشد و Business Logic داخل آن قرار نگیرد.

الگوی کلی:

Parse → Authenticate → Validate → Authorize → Service → Response

در کد فعلی ممکن است بخشی از منطق داخل Route Handlerها وجود داشته باشد؛ این سند معماری هدف را مشخص می‌کند و refactor آن بخش‌ها باید به‌صورت تدریجی انجام شود.

Business Logic

قوانین دامنه و منطق اصلی سیستم در lib/ قرار می‌گیرند.

نمونه‌ها:

AI orchestration

Rebalance / scheduling

Time tracking

Day calculation

Summary calculation

Rate limiting

Domain rules

منطق دامنه نباید به HTTP وابسته باشد.

Pure / Framework-independent Components

تا حد امکان، الگوریتم‌های اصلی سیستم مستقل از HTTP و UI نگه داشته می‌شوند.

به‌خصوص:

planner/rebalance.ts

منطق اصلی تحلیل Task در lib/ai/analyzeTask.ts

نباید برای اجرای خود به Route Handler یا Component وابسته باشند.

3.1 Layered Architecture

┌─ PRESENTATION ──────────────────────────────────────────┐

│ Server Components: app/layout.tsx, app/dashboard/*     │

│ Client Components: components/, contexts/               │

│ PWA · Tailwind · RTL                                    │

│                                                         │

│ UI + interaction + client state                        │

└───────────────────────┬─────────────────────────────────┘

│

│ HTTP / JSON

│ httpOnly cookie

▼

┌─ API LAYER ─────────────────────────────────────────────┐

│ app/api/*/route.ts                                      │

│                                                         │

│ Parse → Auth → Validation → Authorization → Service    │

│                                                         │

│ Thin HTTP boundary                                      │

└───────────────────────┬─────────────────────────────────┘

│

▼

┌─ BUSINESS / DOMAIN LOGIC ───────────────────────────────┐

│ app/lib/                                                │

│                                                         │

│ auth/                                                   │

│ ai/                                                     │

│ planner/                                                │

│ domain/                                                 │

│ time/                                                   │

│                                                         │

│ Business rules + algorithms + orchestration             │

└───────────────┬──────────────────────┬──────────────────┘

│                      │

│ Prisma               │ HTTPS

▼                      ▼

┌─────────────────────────┐   ┌───────────────────────────┐

│ DATABASE                │   │ EXTERNAL SERVICES         │

│ PostgreSQL + Prisma     │   │ AI Provider               │

│                         │   │                           │

│ User                    │   │ 1xai.ir                  │

│ Task                    │   │ OpenAI-compatible API     │

│ DailyPlan               │   │                           │

│ TaskEvent (future)      │   │ Future: email/storage/... │

└─────────────────────────┘   └───────────────────────────┘

3.2 مسئولیت لایه‌ها

3.3 قوانین معماری

Rule 1 — Server Components می‌توانند مستقیماً داده بخوانند

برای خواندن داده در Server Components، استفاده مستقیم از Service/Prisma مجاز است.

Server Component

↓

Service / Domain Logic

↓

Prisma

↓

PostgreSQL

نیازی نیست Server Component برای هر read داخلی ابتدا HTTP request به /api/* ارسال کند.

در مقابل:

Client Component

↓

API Route Handler

↓

Service / Domain Logic

↓

Prisma

بنابراین API یک boundary واقعی برای Client ↔ Server است، نه یک الزام مصنوعی برای تمام server-side reads.

3.4 Rule 2 — Route Handlerها Thin هستند

Route Handler مسئول orchestration سطح HTTP است، نه Business Logic.

مسئولیت‌های مجاز:

دریافت request

Parse کردن ورودی

Authentication

Authorization / ownership check

Validation با Zod

فراخوانی Service / Domain Logic

تبدیل نتیجه به HTTP response

Business Rule، الگوریتم، محاسبه و تصمیم دامنه باید خارج از Route Handler قرار گیرد.

این separation باعث می‌شود Business Logic:

قابل تست‌تر باشد

از HTTP مستقل باشد

از Server Component قابل استفاده باشد

از Route Handlerهای مختلف قابل استفاده باشد

در آینده راحت‌تر تغییر کند

3.5 Rule 3 — AI یک قابلیت اختیاری است، نه Business Authority

AI در:

lib/ai/analyzeTask.ts

به‌عنوان یک سرویس داخلی قرار دارد که External AI Provider را فراخوانی می‌کند.

AI مسئول ارائه تحلیل است:

Task

↓

AI Analysis

↓

score

priority

estimatedTime

category

reason

اما AI تصمیم نهایی درباره برنامه روزانه نمی‌گیرد.

تصمیم نهایی توسط:

Business Rules

Rebalance Engine

User

تعیین می‌شود.

AI نباید مستقیماً جایگزین Business Logic شود.

همچنین:

ساخت Task هرگز به AI وابسته نیست.

Task می‌تواند بدون هیچ درخواست AI ساخته شود.

AI فقط زمانی اجرا می‌شود که کاربر صریحاً درخواست Analyze بدهد.

3.6 Rule 4 — Rebalance به‌صورت Lazy / On-Demand اجرا می‌شود

Rebalance در DailyPilot یک scheduling operation است و نباید بعد از هر mutation به‌صورت خودکار اجرا شود.

عملیات‌هایی مانند:

Create Task

Delete Task

Complete Task

Edit Task

AI Analyze

ابتدا فقط state اصلی سیستم را تغییر می‌دهند.

سپس زمانی که کاربر وارد Dashboard و Calendar و مشخصاً نمای یک روز می‌شود، سیستم بررسی می‌کند که آیا آن روز نسبت به آخرین Rebalance تغییر کرده است یا خیر.

مدل مفهومی:

Mutation

↓

Update domain state

↓

Mark day as needing recalculation

↓

No immediate rebalance

↓

User opens Calendar Day

↓

Check whether rebalance is needed

↓

Yes → Run Rebalance

↓

Persist allocation

↓

Show current schedule

اگر هیچ تغییر مرتبطی از آخرین Rebalance وجود نداشته باشد، Rebalance مجدداً اجرا نمی‌شود.

اصل مهم

قانون معماری این نیست که:

«هر بار Calendar باز شد Rebalance کن.»

بلکه:

«هنگام ورود به نمای روز، نیاز به Rebalance را بررسی کن و فقط در صورت stale/dirty بودن برنامه، Rebalance را اجرا کن.»

برای این منظور سیستم باید یک مکانیزم قابل اتکا برای تشخیص stale بودن allocation داشته باشد؛ مانند versioning، dirty state یا معادل مناسب آن.

جزئیات implementation این مکانیزم باید بر اساس مدل داده فعلی پروژه تعیین شود و قبل از تغییر کد بررسی شود.

Analyze باعث Rebalance نمی‌شود

AI Analyze صرفاً تحلیل Task را تولید و ذخیره می‌کند.

Analyze

↓

Save AI result

↓

No immediate Rebalance

وقتی کاربر بعداً وارد روز مربوطه شود، سیستم بررسی می‌کند آیا تغییرات AI روی scheduling inputs اثر گذاشته‌اند یا خیر و در صورت نیاز Rebalance انجام می‌شود.

3.7 Rebalance باید Idempotent باشد

اجرای Rebalance با input یکسان نباید باعث تغییرات غیرضروری یا رفتار غیرقابل پیش‌بینی شود.

به‌صورت مفهومی:

same inputs

↓

same allocation

این ویژگی برای مدل Lazy مهم است، چون ممکن است یک روز چندین بار باز شود یا چند درخواست همزمان برای مشاهده آن ایجاد شود.

3.8 Rule 5 — Database منبع حقیقت است

PostgreSQL منبع اصلی حقیقت سیستم است و Prisma abstraction اصلی دسترسی به آن است.

مدل‌های اصلی فعلی:

User

Task

DailyPlan

و در آینده احتمالاً:

TaskEvent

Business Logic نباید state پایدار را صرفاً در memory نگه دارد.

همچنین Client نباید مستقیماً به Database دسترسی داشته باشد.

3.9 Rule 6 — External AI Provider فقط از لایه AI قابل دسترسی است

External AI Provider فعلی:

1xai.ir

با API سازگار با OpenAI.

Configuration از طریق environment variables انجام می‌شود، مانند:

AIXAI_BASE_URL

AIXAI_MODEL

API key مربوطه

این اطلاعات فقط در Server-side AI layer قابل استفاده هستند.

هیچ Client Component نباید:

API key

secret

provider credential

را دریافت کند.

هدف این abstraction این است که در آینده بتوان provider را بدون پخش شدن وابستگی به provider در کل پروژه تغییر داد.

3.10 جریان‌های اصلی سیستم

A) ساخت Task بدون AI

Client Component

↓

POST /api/tasks

↓

Authentication

↓

Zod Validation

↓

Task Service / Domain Logic

↓

Prisma

↓

PostgreSQL

Task با اطلاعات اصلی مانند:

title

scheduledDate

dayKey

userId

ذخیره می‌شود.

هیچ درخواست اجباری به External AI Service انجام نمی‌شود.

پس:

AI failure نباید مانع ساخت Task شود.

B) تحلیل اختیاری Task با AI

Client

↓

POST /api/tasks/[id]/analyze

↓

Authentication

↓

Ownership / Authorization

↓

lib/ai/analyzeTask.ts

↓

External AI Provider

↓

Timeout / Retry

↓

Robust JSON parsing

↓

Zod aiSchema validation

↓

Persist AI result

خروجی شامل مواردی مانند:

score

priority

estimatedTime

category

reason

است.

در صورت نبود configuration لازم، fallback مناسب مانند mock.ts می‌تواند برای محیط توسعه وجود داشته باشد.

AI فقط پیشنهاد می‌دهد و authority نهایی برنامه‌ریزی نیست.

C) اتمام Task و Time Tracking

Client

↓

PATCH /api/tasks/[id]/complete

↓

Authentication

↓

Ownership / Authorization

↓

Update Task

↓

PostgreSQL

اطلاعاتی مانند:

status = DONE

spentMinutes

completedOn

previousScheduledDate

ثبت می‌شوند.

در این مرحله Rebalance مستقیماً اجرا نمی‌شود.

روز مربوطه به‌عنوان دارای state جدید در نظر گرفته می‌شود و هنگام مشاهده مجدد آن روز، Lazy Rebalance در صورت نیاز اجرا خواهد شد.

پس جریان کامل:

Complete Task

↓

Persist completion

↓

Day becomes stale / needs recalculation

↓

Later: user opens that day

↓

Lazy Rebalance

↓

Updated remaining allocation

3.11 استاندارد API Response

تمام APIهای پروژه باید در نهایت از یک response contract استاندارد استفاده کنند:

Success

{

"ok": true,

"data": {}

}

Error

{

"ok": false,

"error": {

"code": "VALIDATION_ERROR",

"message": "Invalid request"

}

}

هدف این قرارداد:

رفتار یکسان APIها

ساده‌تر شدن Client-side error handling

کاهش شرط‌های متفاوت در frontend

قابلیت توسعه بهتر API در آینده

جزئیات error codes و mapping خطاها می‌تواند در API contract documentation تکمیل شود.

3.12 Architecture Decisions نهایی

تصمیم‌های این بخش از این قرار هستند:

ADR-01 — Server-side Reads

Server Components می‌توانند برای read مستقیم از Service/Prisma استفاده کنند.

Client Components برای ارتباط با Server از API استفاده می‌کنند.

دلیل: جلوگیری از HTTP hop غیرضروری در Server Components و حفظ boundary مشخص برای Client ↔ Server.

ADR-02 — Thin Route Handlers

Route Handlerها باید Thin باشند و Business Logic در lib/ یا Service/Domain layer قرار گیرد.

دلیل: جداسازی HTTP concerns از Business Logic و افزایش testability، reuse و maintainability.

ADR-03 — Lazy Rebalance

Rebalance بعد از هر mutation به‌صورت فوری اجرا نمی‌شود.

هنگام ورود کاربر به نمای روز در Calendar، سیستم بررسی می‌کند که آیا allocation آن روز stale است یا خیر و فقط در صورت نیاز Rebalance را اجرا می‌کند.

دلیل: جلوگیری از محاسبات غیرضروری، کاهش coupling بین mutation و scheduling و در عین حال حفظ تجربه‌ای که برای کاربر به‌صورت live/به‌روز دیده می‌شود.

ADR-04 — Standard API Response

APIها از contract استاندارد زیر استفاده می‌کنند:

{ ok, data, error }

دلیل: ایجاد قرارداد یکنواخت و قابل پیش‌بینی بین Client و API Layer.

ADR-05 — AI Is Optional

ساخت و مدیریت Task بدون AI باید کاملاً امکان‌پذیر باشد.

AI فقط با درخواست صریح کاربر اجرا می‌شود و authority نهایی scheduling نیست.

دلیل: جلوگیری از coupling محصول به AI و حفظ Business Logic مستقل از External AI Provider.

وضعیت این بخش

بخش ۳ از نظر تصمیم‌های معماری قفل شده است.

هر تغییر آینده در این اصول باید به‌عنوان یک Architecture Decision جدید بررسی شود، نه اینکه صرفاً در کد اعمال شود.

پیاده‌سازی جزئیات، refactor کد فعلی و انتخاب mechanism دقیق برای stale/dirty detection در مراحل بعدی انجام می‌شود.

4. Technology Stack

4.0 اصل حاکم

Technology Stack باید وضعیت واقعی و فعلی پروژه را ثبت کند، نه وضعیت آرمانی یا تکنولوژی‌هایی که صرفاً ممکن است در آینده استفاده شوند.

نسخه‌ها و dependencyهای اصلی بر اساس وضعیت واقعی package.json ثبت می‌شوند.

هر Major Upgrade مهم باید به‌صورت یک تصمیم فنی مستقل و در صورت نیاز با ADR جداگانه بررسی شود.

تکنولوژی جدید فقط زمانی وارد Stack می‌شود که نیاز واقعی محصول یا معماری آن را توجیه کند.

ابزارها و dependencyهای unused نباید صرفاً به دلیل رایج بودن در پروژه نگه داشته یا اضافه شوند.

4.1 Technology Stack

Frontend / Web Platform

Backend / Application

Database

4.2 Custom CSS Design System

پروژه از Tailwind CSS استفاده نمی‌کند.

UI با یک سیستم CSS اختصاصی ساخته شده که شامل:

CSS Variables / Design Tokens

Theme variables

UI primitives

کلاس‌های اختصاصی با prefix dp-*

Responsive styling

RTL-aware styling

نمونه‌هایی از primitiveهای موجود:

.dp-btn

.dp-input

.dp-card

.dp-install-grid

.dp-qr-wrap

.dp-offline-chip

.dp-queued-chip

globals.css محل اصلی این Design System است.

PostCSS و Autoprefixer در این ساختار برای پردازش CSS و vendor prefixing استفاده می‌شوند و جایگزین Tailwind نیستند.

Decision

Tailwind CSS وارد Stack پروژه نمی‌شود مگر اینکه در آینده یک نیاز معماری/محصولی مشخص برای تغییر سیستم Styling ایجاد شود.

4.3 Support Libraries

کتابخانه‌های اصلی فعلی:

هر library باید بر اساس usage واقعی پروژه ارزیابی شود و dependency جدید بدون نیاز واقعی اضافه نشود.

4.4 PWA و Mobile Platform

DailyPilot علاوه بر Web، به‌عنوان Progressive Web App (PWA) ارائه می‌شود.

هدف این است که یک codebase بتواند تجربه Web و Mobile را پوشش دهد و کاربر بتواند DailyPilot را در صورت پشتیبانی مرورگر/سیستم‌عامل روی Home Screen نصب کند، بدون اینکه در v1 نیاز به Native Android یا Native iOS جداگانه داشته باشیم.

PWA Responsibilities

PWA در پروژه شامل موارد زیر است:

Web App Manifest

Service Worker

Install Flow

Responsive Mobile UI

Mobile-oriented UX

App Icons / Display Configuration

Offline / Cache behavior

Offline state indicators

Mobile entry points

Current Implementation

وضعیت فعلی repository نشان می‌دهد PWA در پروژه واقعاً فعال است و صرفاً یک تصمیم آینده نیست.

اجزای موجود/فعال شامل:

public/sw.js

Manifest با مسیر /manifest.webmanifest

Service Worker configuration در next.config.js

تنظیمات مربوط به Service-Worker-Allowed

Cache-Control مناسب برای Service Worker و Manifest

UI مربوط به Install

UI مربوط به QR Code

Offline state indicators

Queued/offline state UI

Service Worker برای navigation و assetها strategyهای caching مشخص دارد و API/RSC نباید به‌صورت ناخواسته cache شوند.

Architecture Boundary

PWA یک لایه مستقل از Business Logic نیست؛ بخشی از Web / Presentation Platform است.

Business / Domain

↑

Application / API

↑

Next.js

↑

Web / PWA Platform

├── Manifest

├── Service Worker

├── Install Flow

├── Responsive UI

└── Mobile UX

Business Logic نباید به Service Worker، install mechanism یا browser-specific APIs وابسته شود.

4.5 Mobile Installation

Install Flow باید بر اساس capability واقعی platform/browser طراحی شود.

Android

در browserهایی که PWA installation و install prompt را پشتیبانی می‌کنند:

UI می‌تواند install action را در اختیار کاربر قرار دهد.

در صورت available بودن native install prompt، می‌توان آن را trigger کرد.

در صورت نبود capability مناسب، UX باید fallback داشته باشد.

iOS / iPhone

نباید فرض شود که installation flow در iOS مشابه Android است.

در صورت نبود install prompt مستقیم، UI باید کاربر را به روش مناسب سیستم‌عامل، مانند Add to Home Screen، هدایت کند.

جزئیات دقیق UX و browser capability detection بخشی از Implementation و UX layer است، نه Business Logic.

4.6 QR Code و Mobile Entry

DailyPilot از QR Code به‌عنوان یک Mobile Entry Point استفاده می‌کند.

هدف اصلی:

Desktop

↓

Scan QR

↓

Open DailyPilot on Phone

↓

Install PWA if supported

کتابخانه qrcode مسئول تولید QR Code است.

QR Code مسئول نصب PWA نیست؛ فقط مسیر سریع انتقال کاربر از Desktop به Mobile را فراهم می‌کند.

Installation توسط browser / operating system و PWA capabilities انجام می‌شود.

4.7 PWA vs Native Applications

در v1:

Web + PWA با یک codebase ارائه می‌شود.

Native Android application جداگانه نداریم.

Native iOS application جداگانه نداریم.

App Store / Play Store distribution جزو scope فعلی نیست.

Native application فقط در آینده و در صورت ایجاد نیاز واقعی مانند:

دسترسی به Native APIs

Background capabilities پیشرفته

Push/OS integrations خاص

App Store distribution

محدودیت‌های جدی PWA

به‌عنوان یک تصمیم معماری مستقل بررسی خواهد شد.

4.8 Development Tooling

Development tooling فعلی:

ESLint

eslint-config-next

PostCSS

Autoprefixer

Scripts فعلی پروژه:

dev

build

start

lint

در وضعیت فعلی:

Test framework مستقل وجود ندارد.

test script وجود ندارد.

typecheck script مستقل وجود ندارد.

db:* scripts مستقل وجود ندارد.

اضافه کردن این toolingها باید در قالب نیاز واقعی development/CI بررسی شود و صرفاً برای کامل‌تر شدن package.json انجام نشود.

4.9 External Services

AI Provider

DailyPilot از یک OpenAI-compatible AI provider استفاده می‌کند.

تنظیمات provider از طریق environment variables انجام می‌شود:

AIXAI_BASE_URL

AIXAI_MODEL

Integration باید فقط از طریق lib/ai انجام شود.

هیچ Client Component نباید مستقیماً به provider یا secretهای آن دسترسی داشته باشد.

Future / TBD

موارد زیر فعلاً بخشی از Stack قطعی نیستند:

Email provider

Object/File Storage

Payment provider

Subscription infrastructure

Push notification provider

هرکدام در صورت ورود به محصول باید جداگانه بررسی و ثبت شوند.

4.10 Technical Debt / Upgrade Candidates

برخی تکنولوژی‌های فعلی از نظر عمر یا maintenance ممکن است در آینده نیاز به بازبینی داشته باشند:

Next.js 13.5.6

bcrypt native dependency

moment-jalaali

سایر dependencyهای قدیمی

این موارد فعلاً فقط به‌عنوان Technical Debt / Upgrade Candidates ثبت می‌شوند.

هیچ upgrade عمده‌ای صرفاً برای modern بودن انجام نمی‌شود.

Major Upgrade باید:

نیاز یا مشکل مشخص داشته باشد.

Impact آن بررسی شود.

Compatibility بررسی شود.

در صورت مهم بودن، ADR مستقل داشته باشد.

سپس به‌صورت کنترل‌شده اجرا شود.

4.11 Version Policy

سیاست نسخه‌ها:

وضعیت فعلی پروژه با نسخه‌های واقعی ثبت می‌شود.

package.json مرجع اصلی dependencyهای نصب‌شده است.

تغییر Major Version یک تصمیم فنی مستقل محسوب می‌شود.

Upgradeهای مهم نباید به‌صورت silent در جریان feature development انجام شوند.

dependency جدید باید دارای دلیل مشخص و usage واقعی باشد.

4.12 Technology Decisions

TECH-01 — Route Handler as Client API Boundary

Client Components برای ارتباط با Server از Route Handlers استفاده می‌کنند.

Server Components در صورت نیاز می‌توانند مستقیماً از Service/Prisma داده دریافت کنند.

Server Actions فعلاً وارد معماری نمی‌شوند تا دو الگوی موازی برای Client → Server ایجاد نشود.

TECH-02 — Technology Stack Reflects Current Reality

Technology Stack باید وضعیت واقعی repository را ثبت کند، نه تکنولوژی‌های پیشنهادی یا فرضی.

TECH-03 — PWA as Mobile Platform

DailyPilot در v1 به‌صورت PWA ارائه می‌شود تا Web و Mobile با یک codebase پوشش داده شوند.

TECH-04 — Cross-Platform Install Flow

Install experience باید capability-based باشد و تفاوت Android و iOS را در نظر بگیرد.

TECH-05 — QR Code as Mobile Entry Point

QR Code برای انتقال سریع کاربر از Desktop به Mobile استفاده می‌شود و مسئولیت installation را بر عهده ندارد.

TECH-06 — Custom CSS Instead of Tailwind

Tailwind CSS در پروژه استفاده نمی‌شود و dependency آن نیز اضافه نمی‌شود.

سیستم Styling فعلی بر پایه:

CSS Variables / Design Tokens

Custom CSS

dp-* UI primitives

PostCSS

Autoprefixer

است.

4.13 وضعیت بخش ۴

بخش ۴ بر اساس وضعیت واقعی Technology Stack پروژه تثبیت شد.

موارد قبلی که نیاز به بررسی داشتند اکنون تعیین تکلیف شده‌اند:

Tailwind: بررسی شد؛ استفاده نمی‌شود و وارد Stack نمی‌شود.

PWA: بررسی شد؛ implementation فعال دارد و بخشی از Product Stack است.

QR Code: dependency واقعی محصول است و برای Desktop → Mobile entry استفاده می‌شود.

Install Flow: بخشی از PWA/Mobile UX است و باید capability-based باشد.

Server Actions: فعلاً استفاده نمی‌شود.

Next.js / bcrypt / moment-jalaali: فعلاً Technical Debt / Upgrade Candidate هستند و upgrade آن‌ها خارج از scope فعلی است.

Section 5 — Domain Architecture را بر اساس تصمیم‌های زیر نهایی کن و به عنوان نسخه نهایی/LOCKED در docs/architecture.md قرار بده.

هدف این Section این است که مسئولیت هر Domain، وابستگی‌ها و Business Rules اصلی سیستم را مشخص کند؛ نه اینکه وارد جزئیات implementation یا schema دقیق دیتابیس شود.

5. Domain Architecture

5.0 Domain Boundaries & Principles

هیچ Domain اصلی نباید به AI وابسته باشد.

Tasks و Daily Planning هسته اصلی Domain هستند.

Business Logic نباید به UI، Route Handler یا AI Provider وابسته باشد.

AI Analysis یک قابلیت اختیاری و پیشنهاددهنده است، نه مرجع نهایی تصمیم‌گیری.

Daily Planning مسئول تخصیص زمان و Rebalance است.

Rebalance باید تا حد امکان pure و idempotent طراحی شود.

Rebalance در V1 به صورت Lazy / On-Demand اجرا می‌شود، نه بعد از هر mutation.

زمان محلی کاربر و timezone مرجع محاسبات روزانه است.

dayKey باید بر اساس timezone کاربر تفسیر شود.

تبصره (Canonical Day): نمایش canonical روز به‌صورت یک تصمیم مستقل در Section 6 تعیین می‌شود.
dayKey جلالی فعلی در کد، جزئیات implementation است و قرارداد دائمی مدل داده نیست.
timezone یک نگرانی دامنه‌ای باقی می‌ماند، اما قرارداد دائمی دامنه به نمایش تقویمی فعلی گره نمی‌خورد.

Time Tracking در V1 یک قابلیت قطعی و فعال است.

در V1 برای Time Tracking نیازی به Entity جداگانه TimeEntry نداریم و مقدار actual duration روی خود Task با spentMinutes ذخیره می‌شود.

در آینده، اگر session history، timer، pause/resume یا چند بازه زمانی برای یک Task لازم شد، TimeEntry می‌تواند به عنوان Entity مستقل اضافه شود.

Domainهای Habits و Notifications فعلاً Deferred هستند.

5.1 Domain Dependency Overview

Mental model:

Authentication

↓

Users

↓

Tasks

↙  ↓  ↘

TaskEvent  Time Tracking

(V1: زیرمجموعه Tasks)

AI Analysis

(اختیاری؛ قابلیت متصل به Task)

Daily Planning

↓

Rebalance

این نمودار بیانگر مسئولیت و dependency مفهومی است و الزاماً به معنی import مستقیم بین ماژول‌ها نیست. جهت فلش‌ها نشان‌دهنده وابستگی/مسئولیت مفهومی است.

نکات تکمیلی:

AI Analysis به Task متصل است و یک قابلیت اختیاری محسوب می‌شود؛ Task و Domainهای اصلی نباید به AI وابسته باشند.

Time Tracking در V1 زیرمجموعه Domain Tasks است و Domain/Entity مستقل ندارد.

TaskEvent زیرمجموعه Tasks است و در آینده می‌تواند به‌عنوان منبع تاریخچه برای AI Coach و Analytics مصرف شود.

5.2 Authentication

Responsibility

Authentication مسئول این موارد است:

Register

Login

Logout

Authentication request

JWT/session handling

Password hashing

اعتبارسنجی اطلاعات authentication

تشخیص identity کاربر فعلی

خروجی اصلی این Domain یک authenticated identity است؛ برای مثال از طریق getCurrentUser().

Authentication نباید Business Logic مربوط به موارد زیر را در خود نگه دارد:

Task

Planning

Rebalance

AI Analysis

Current implementation boundary

Authentication در این بخش‌ها فعال است:

app/api/auth/*

lib/getCurrentUser.ts

JWT باید در HTTP-only cookie نگهداری شود و passwordها با bcrypt مدیریت شوند.

Rate limiting فعلاً محدود به implementation موجود است و اگر در آینده production-grade rate limiting لازم شد، باید به عنوان تصمیم جداگانه بررسی شود.

5.3 Users

Responsibility

Users مسئول موارد زیر است:

User identity/profile

User preferences

timezone

locale

calendar preference

plan

فعلاً:

User.plan = FREE | PRO

برای gating قابلیت‌های محصول کافی است.

در این مرحله Entitlement یا Quota به عنوان Domain/Entity جدا ایجاد نمی‌شود.

User همچنین root ownership سیستم است:

User

├── Tasks

└── Daily Planning data

هر Task و داده برنامه‌ریزی باید متعلق به یک User مشخص باشد.

جزئیات دقیق fieldها در Section 6 نهایی می‌شوند.

5.4 Tasks

Tasks یکی از Core Domainهای DailyPilot است.

Responsibility

Tasks مسئول lifecycle اصلی Task است:

Create

Edit

Delete

Status

Scheduling

Completion

ارتباط با AI Analysis

ارتباط با TaskEvent

نگهداری actual duration

Task باید بدون AI نیز کاملاً معتبر و قابل استفاده باشد.

یعنی:

Create Task

↓

Task exists

و AI فقط یک قابلیت optional روی آن است:

Task

↓

Optional AI Analysis

Important distinction

این موارد باید از هم جدا باقی بمانند:

score: وزن عددی 0 تا 100 برای ranking/weighting

priority: سطح نمایشی HIGH / MEDIUM / LOW

estimatedTime: زمان تخمینی

allocatedMinutes: زمانی که Planning به Task اختصاص داده

spentMinutes: زمان واقعی صرف‌شده

این مقادیر یک مفهوم واحد نیستند.

Task Edit Rule

اگر متن یا اطلاعات مؤثر Task تغییر کند، AI Analysis قبلی نباید به صورت ضمنی معتبر فرض شود.

در چنین حالتی:

Task changed

↓

Previous AI analysis = stale / invalid

↓

User explicitly requests Analyze again

اگر تغییر آن‌قدر بنیادی باشد که ماهیت کار را عوض کند، می‌توان آن را به عنوان Task جدید در نظر گرفت.

Implementation Gap — Task Edit API

در کد فعلی route عمومی برای ویرایش Task، مانند تغییر متن/دسته/تاریخ بدون تحلیل مجدد، وجود ندارد و ویرایش عملاً فقط از مسیر re-analyze ممکن است.

این اختلاف با قانون بالا به عنوان Architecture Gap / Technical Debt ثبت می‌شود و در implementation plan اصلاح خواهد شد؛ بدون تغییر رفتاری غیرضروری در این مرحله.

5.4.1 Task Completion & Time Tracking

Time Tracking در V1 قطعی است و نباید به نسخه آینده منتقل شود.

Flow:

User clicks "Complete"

↓

Ask actual duration

↓

Validate duration

↓

Save:

status = DONE

spentMinutes = actual duration

completedOn = user's local date

↓

Planning data becomes stale if needed

بنابراین Complete کردن Task فقط تغییر status نیست.

کاربر باید هنگام Complete شدن Task بتواند مشخص کند:

این Task واقعاً چند دقیقه طول کشید؟

مقدار واردشده در spentMinutes ذخیره می‌شود و در آینده برای مقایسه planned vs actual استفاده خواهد شد.

مدل مفهومی:

estimatedTime

↓

allocatedMinutes

↓

actual work

↓

spentMinutes

هدف این است که سیستم فقط بگوید «چه چیزی را برنامه‌ریزی کردی» نباشد؛ بلکه بتواند بفهمد:

Planned Time vs Actual Time

در V1 TimeEntry جداگانه ایجاد نمی‌شود.

اگر در آینده نیاز به موارد زیر به وجود آمد:

multiple work sessions

start/stop timer

pause/resume

session history

چند بازه زمانی برای یک Task

آن زمان ایجاد Entity جداگانه TimeEntry بررسی شود.

5.5 TaskEvent

TaskEvent فعلاً زیرمجموعه Domain Tasks است و Domain مستقل نیست.

هدف آن ثبت history مهم lifecycle Task است.

رویدادهای پایه:

CREATED

ANALYZED

ROLLED_OVER

COMPLETED

اطلاعات مفهومی:

taskId

eventType

occurredAt

قابل توسعه بودن (Extensible): این فهرست حداقلی است و قرارداد بسته‌ای نیست. از آنجا که ویرایش Task تحلیل قبلی AI را stale/invalid می‌کند، رویداد EDITED / UPDATED به‌عنوان candidate برای ثبت تغییرات در نظر گرفته می‌شود. نوع‌های نهایی enum رویدادها در Section 6 (Data Model) تعیین و قطعی می‌شوند و نباید از همین‌جا بیش‌ازحد specification شوند.

جزئیات schema در Section 6 مشخص می‌شود.

TaskEvent در آینده می‌تواند برای موارد زیر استفاده شود:

Analytics

AI Coach / Memory

Debugging

Audit

رفتارشناسی Task

5.6 Daily Planning

Daily Planning مسئول تبدیل مجموعه Taskها به یک برنامه متناسب با ظرفیت واقعی روز است.

Inputهای اصلی:

Open Tasks

estimatedTime

score

availableMinutes

scheduling rules

current Task state

Outputهای اصلی:

allocatedMinutes

daily planning summary

rollover candidates

Daily Planning نباید به UI یا HTTP وابسته باشد.

Summary & Day History

داده‌هایی مانند:

spent

saved

committed

نشانگرهای تاریخ

summary/history

بخشی از Daily Planning هستند.

فایل‌هایی مانند planner/summary.ts یک Domain جدید ایجاد نمی‌کنند و تا زمانی که بررسی کد یک مرز مستقل واقعی نشان ندهد، به عنوان supporting component / implementation detail همین Domain در نظر گرفته می‌شوند.

Core Principle

کاربر ابتدا ظرفیت واقعی روز را مشخص می‌کند:

availableMinutes

سپس Planning تلاش می‌کند Taskها را داخل این ظرفیت قرار دهد.

هدف:

Avoid overbooking

5.6.1 Rebalance

Rebalance بخشی از Daily Planning است.

در V1 الگوریتم فعلی از weight زیر استفاده می‌کند:

weight = estimatedTime × (0.5 + score / 200)

این فرمول implementation strategy فعلی است و نباید به عنوان قرارداد دائمی معماری در نظر گرفته شود.

قرارداد اصلی Rebalance باید بیشتر روی Input/Output و responsibility آن متمرکز باشد تا یک فرمول خاص.

Properties

Rebalance باید:

تا حد امکان pure باشد

idempotent باشد

مستقل از UI باشد

مستقل از HTTP باشد

قابل تست باشد

در implementation فعلی، مواردی مانند:

حفظ IN_PROGRESS

حذف سهم‌های بسیار کوچک به عنوان rollover candidate

گرد کردن allocation به مضرب 5

وجود دارند.

این‌ها implementation rules فعلی هستند و در صورت تغییر الگوریتم می‌توانند evolve شوند.

5.6.2 Lazy / On-Demand Rebalance

Rebalance در V1 بعد از هر تغییر Task اجرا نمی‌شود.

Mutationهایی مانند:

Create

Edit

Delete

Complete

Analyze

ابتدا state اصلی را تغییر می‌دهند.

در صورت تأثیرگذاری روی planning:

Daily Plan = stale

سپس زمانی که کاربر Dashboard / Calendar / Day view را باز می‌کند:

Is plan stale?

↓

Yes → Rebalance

No  → use current allocation

این تصمیم برای جلوگیری از اجرای غیرضروری Rebalance و ساده نگه داشتن flow انتخاب شده است.

جزئیات دقیق stale detection، مانند:

needsRebalance

rebalancedAt

versioning

یا mechanism مشابه

در Section 6 و Data Model نهایی می‌شود.

5.6.3 Rollover Ownership

مرز مالکیت عملیات Rollover بین سه بخش شفاف است:

Daily Planning تعیین می‌کند که یک Task کاندید rollover است؛ تشخیص کاندیدا بر اساس قواعد planning مانند سهم‌های کوچک یا overdue انجام می‌شود.

Tasks مالک اجرای mutation واقعی روی Task است؛ مانند تغییر روز/تاریخ برنامه‌ریزی‌شده، مثلاً scheduledDate.

TaskEvent رویداد ROLLED_OVER را ثبت می‌کند.

مدل مفهومی:

Daily Planning: تشخیص کاندیدا

↓

Tasks: mutation (جابه‌جایی روز)

↓

TaskEvent: ثبت ROLLED_OVER

5.7 AI Analysis

AI Analysis مسئول تحلیل اختیاری Task است.

خروجی فعلی می‌تواند شامل موارد زیر باشد:

score

priority

estimatedTime

category

reason

AI فقط پیشنهاد می‌دهد.

مدل مفهومی:

AI

↓

Suggestion

↓

Daily Planning / User decision

AI نباید authority نهایی برای scheduling یا business decisions باشد.

Trigger

AI Analysis فقط با درخواست صریح User اجرا می‌شود.

Create Task نباید به صورت implicit باعث call به AI شود.

Provider-specific logic نیز باید پشت lib/ai مخفی بماند.

5.8 Time Tracking

Time Tracking در V1 فعال است.

در V1 فقط aggregate actual duration روی Task نگهداری می‌شود:

Task

├── estimatedTime

├── allocatedMinutes

└── spentMinutes

این مدل فعلاً از ایجاد complexity غیرضروری جلوگیری می‌کند.

مفهوم اصلی:

Plan → Do → Measure → Improve

داده actual time باید در آینده برای موارد زیر قابل استفاده باشد:

planned vs actual comparison

بهتر شدن estimation

analytics

بهبود planning

TimeEntry فعلاً Deferred است، اما خود Time Tracking Deferred نیست.

5.9 Habits — Deferred

Habit Building در roadmap آینده قرار دارد.

ممکن است در آینده شامل موارد زیر باشد:

Habit

Streak

Consistency

Habit history

Atomic Habits concepts

در V1 Domain فعال محسوب نمی‌شود.

وجود migration یا preparation احتمالی در database به معنی فعال بودن این Domain نیست.

5.10 Notifications — Deferred

Notifications فعلاً Domain فعال نیست.

در آینده ممکن است شامل موارد زیر باشد:

Task reminders

Overdue notifications

Push notifications

Email notifications

PWA offline indicators یا install UI نباید با Notification Domain اشتباه گرفته شوند.

5.11 Domain Rules Summary

قواعد نهایی Domain در V1:

Task بدون AI کاملاً معتبر است.

AI یک قابلیت optional است.

AI authority نهایی برای planning نیست.

score و priority دو مفهوم جدا هستند.

estimatedTime با spentMinutes متفاوت است.

allocatedMinutes با spentMinutes متفاوت است.

Complete کردن Task شامل ثبت actual duration است.

Time Tracking در V1 فعال و قطعی است.

در V1 TimeEntry Entity جدا نداریم.

spentMinutes روی Task ذخیره می‌شود.

Daily Planning مالک allocation است.

Rebalance بخشی از Daily Planning است.

Rebalance باید pure/idempotent و قابل تست باشد.

Rebalance در V1 Lazy / On-Demand است.

stale detection متعلق به Daily Planning است.

mechanism دقیق stale detection در Section 6 مشخص می‌شود.

dayKey بر اساس timezone کاربر تفسیر می‌شود.

TaskEvent فعلاً زیرمجموعه Tasks است.

AI Analysis فقط با trigger صریح User اجرا می‌شود.

AI provider نباید به Domain Logic نشت کند.

User.plan فعلاً برای AI/product gating کافی است.

Entitlement/Quota فعلاً Domain جدا نیست.

Habits فعلاً Deferred است.

Notifications فعلاً Deferred است.

Domain Logic نباید در UI، Route Handler یا AI Provider قرار بگیرد.

نمایش canonical روز در Section 6 تعیین می‌شود؛ dayKey جلالی فعلی قرارداد دائمی نیست.

فهرست رویدادهای TaskEvent extensible است؛ EDITED/UPDATED کاندید برای Section 6 است.

تشخیص Rollover با Daily Planning، اجرای mutation با Tasks و ثبت رویداد با TaskEvent است.

5.12 Final Decisions

5.13 Status

LOCKED

این Section با تصمیم‌های بالا به عنوان Source of Truth معماری Domain در نظر گرفته می‌شود.

در این مرحله implementation جدیدی خارج از این تصمیم‌ها ایجاد نکن.

اگر implementation فعلی با این architecture اختلاف دارد، اختلاف را به عنوان Architecture Gap / Technical Debt مشخص کن و بدون تغییر غیرضروری behavior، آن را برای اصلاح در implementation plan ثبت کن.

تغییرات آینده در این Section فقط در صورت کشف تناقض و به‌صورت یک Architecture Decision جدید (ADR) انجام می‌شود.

6. Database Architecture

6.0 Data Model Principles

این بخش مدل داده و قراردادهای اصلی persistence در V1 را تعریف می‌کند.
جزئیات implementation فقط در صورتی مجاز است که با این قراردادها سازگار باشد.

اصول حاکم

Task مستقل از AI است.
AI فقط یک قابلیت اختیاری روی Task است و نتیجه‌ی تحلیل AI به‌صورت ستون‌های nullable روی خود Task ذخیره می‌شود.
Entity جداگانه‌ی TaskAnalysis در V1 وجود ندارد.

روز کاربر یک مفهوم محلی و مستقل از تقویم نمایشی است.
روز بر اساس user.timezone تعیین می‌شود و نمایش آن می‌تواند Gregorian، Jalali یا تقویم دیگری باشد.

dayKey و completedOn نباید به تقویم نمایشی وابسته باشند.

Rebalance در V1 Lazy / On-Demand است.
بنابراین مدل DailyPlan باید بتواند تشخیص دهد که وضعیت فعلی با آخرین Rebalance همگام نیست.

TimeEntry در V1 وجود ندارد.
Time Tracking فعال است، اما actual duration روی خود Task.spentMinutes ذخیره می‌شود.

Habit و Notification در V1 وجود ندارند و مدل داده‌ای برای آنها ساخته نمی‌شود.

TaskEvent زیرمجموعه‌ی Tasks است و برای ثبت تاریخچه‌ی چرخه‌ی عمر Task استفاده می‌شود.

Summaryهای برنامه در V1 computed-on-read هستند و به‌صورت aggregateهای دائمی روی DailyPlan ذخیره نمی‌شوند.

DailyPlan مالک ظرفیت روز و وضعیت Rebalance است؛ Task مالک state واقعی Task است.

Business Logic نباید به نحوه‌ی نمایش تاریخ در UI یا به نوع تقویم وابسته شود.

category یک فراداده‌ی متعلق به Task است، نه صرفاً خروجی AI.
کاربر می‌تواند آن را تعیین کند؛ AI هنگام Analyze ممکن است پیشنهاد دهد، اما هرگز category انتخاب‌شده‌ی صریح توسط کاربر را بازنویسی نمی‌کند.

Mutationهای Task دو کلاس دارند: Planning-only و Content.
اثر این دو کلاس روی AI fields، category و stale state متفاوت است (۶.۳.۲ و ۶.۳.۵).

6.1 Current Database State

وضعیت فعلی مدل داده بر اساس Schema موجود:

Current Indexes

Task:

[userId, dayKey]

[userId, status]

DailyPlan:

unique [userId, dayKey]

6.2 Target Data Model

6.2.1 User

Responsibility

User ریشه‌ی هویت، تنظیمات شخصی و سطح دسترسی است و مالکیت داده‌های Task و DailyPlan را مشخص می‌کند.

New Fields

enum UserPlan {

FREE

PRO

}

enum CalendarType {

JALALI

GREGORIAN

}

timezone String       @default("Asia/Tehran")

locale   String       @default("fa")

calendar CalendarType @default(JALALI)

plan     UserPlan     @default(FREE)

Rules

timezone برای محاسبات روز محلی استفاده می‌شود.

locale برای localization است و نباید به timezone وابسته باشد.

calendar فقط ترجیح نمایش تقویم است و نباید قرارداد persistence برای dayKey باشد.

plan در V1 تنها مکانیزم gating مربوط به سطح کاربر است.

Entitlement / Quota / Subscription در V1 مدل جدا ندارند.

V1 Timezone Policy

در V1 تغییر timezone از طریق UI پشتیبانی نمی‌شود.

Timezone هنگام ایجاد User مقدار پیش‌فرض دارد:

Asia/Tehran

اگر در آینده تغییر timezone پشتیبانی شود، باید اثر آن روی:

dayKey

completedOn

scheduledDate

DailyPlan

Taskهای برنامه‌ریزی‌شده

به‌صورت یک تصمیم مستقل بررسی شود و در صورت نیاز ADR/migration داشته باشد.

6.2.2 Task

Task هسته‌ی اصلی Domain است.

Responsibilities

Task lifecycle

scheduling

AI analysis state

planning allocation

completion

actual duration

TaskEvent history

Target Rules

Priority

priority باید nullable باشد:

priority = null

یعنی Task می‌تواند قبل از AI Analysis معتبر باشد و نباید به‌صورت جعلی MEDIUM شود.

AI Fields (تحلیل اختیاری)

این فیلدها nullable هستند و نمایانگر آخرین نتیجه‌ی معتبر AI Analysis می‌باشند:

score

priority

estimatedTime

reason

Category (فراداده‌ی کاربر)

nullable است و متعلق به Task است؛ کاربر می‌تواند آن را تعیین کند.

AI هنگام Analyze ممکن است یک category پیشنهاد دهد و فقط در صورتی که مقدار فعلی خالی (null) باشد آن را تنظیم کند.

AI هرگز category انتخاب‌شده‌ی صریح توسط کاربر را بازنویسی نمی‌کند:

AI must never overwrite an explicitly user-selected category.

در V1 جدا کردن userCategory / aiSuggestedCategory لازم نیست. مکانیزم اجرایی تشخیص «انتخاب صریح کاربر» در implementation plan تعیین می‌شود (سیاست امن: مقداردهی فقط وقتی null است).

category جزو گروه invalidation نیست و در Content Mutation پاک نمی‌شود (۶.۳.۵).

Time Tracking

estimatedTime

allocatedMinutes

spentMinutes

سه مفهوم مستقل هستند:

estimatedTime → تخمین مدت Task

allocatedMinutes → زمانی که Planner برای روز اختصاص داده

spentMinutes → زمانی که واقعاً صرف شده

6.2.2.1 Task Date Representation

Canonical Day Key

در V1:

dayKey = YYYY-MM-DD

مثال:

2026-09-06

این مقدار:

Gregorian است

local date کاربر است

مستقل از calendar preference است

توسط سرور و بر اساس user.timezone تعیین می‌شود

از Client به‌عنوان source of truth پذیرفته نمی‌شود

بنابراین:

User.timezone

↓

Server calculates local date

↓

YYYY-MM-DD

↓

dayKey

Jalali بودن تقویم کاربر فقط در Presentation Layer اعمال می‌شود.

completedOn

completedOn نیز همین قرارداد را دارد:

YYYY-MM-DD

و بر اساس timezone کاربر در زمان completion محاسبه می‌شود.

scheduledDate

scheduledDate یک DateTime است که لحظه‌ی شروع روز محلی را به‌صورت یک timestamp مطلق نشان می‌دهد.

یعنی:

User local midnight

↓

absolute instant

↓

scheduledDate

بنابراین:

dayKey → برای grouping و daily queries

scheduledDate → برای نگهداری instant واقعی

calendar → فقط برای presentation

این سه مفهوم نباید با یکدیگر مخلوط شوند.

6.2.2.2 Task Indexes

Index موجود:

@@index([userId, dayKey])

@@index([userId, status])

Index پیشنهادی:

@@index([userId, completedOn])

هدف:

history views

completed-task queries

date-based analytics

future habit/analytics features

6.2.2.3 previousScheduledDate

previousScheduledDate در V1 باقی می‌ماند، اما source of truth تاریخچه نیست.

این field فقط برای compatibility / lightweight previous-state information استفاده می‌شود.

تاریخچه‌ی واقعی mutationها از طریق TaskEvent ثبت می‌شود.

6.2.3 DailyPlan

DailyPlan نماینده‌ی ظرفیت و وضعیت برنامه‌ریزی یک روز برای یک User است.

Existing Responsibility

User + Day → DailyPlan

Target Fields

علاوه بر فیلدهای فعلی:

planVersion       Int  @default(0)

rebalancedVersion Int?

Meaning

planVersion

نسخه‌ی state برنامه‌ریزی آن روز است.

هر mutation مؤثر روی planning باید آن را افزایش دهد.

مثال:

planVersion = 5

یعنی state مؤثر روی برنامه تاکنون پنج بار تغییر کرده است.

rebalancedVersion

آخرین نسخه‌ای که واقعاً Rebalance شده است.

rebalancedVersion = 5

یعنی planner تا نسخه‌ی 5 محاسبه شده است.

اگر:

planVersion > rebalancedVersion

برنامه stale است.

اگر:

rebalancedVersion IS NULL

برنامه هنوز هیچوقت Rebalance نشده است.

6.3 Key Database Decisions

6.3.1 Canonical Day Representation

Final Decision

Gregorian local date با فرمت YYYY-MM-DD

dayKey و completedOn canonical persistence representation هستند.

Rules

محاسبه در Server انجام می‌شود.

user.timezone مرجع تعیین روز است.

Client timezone منبع حقیقت نیست.

Calendar preference روی persistence تأثیر ندارد.

Jalali/Gregorian conversion فقط در Presentation Layer انجام می‌شود.

Migration

تغییر از dayKey جلالی فعلی به Gregorian باید با migration در Application Layer انجام شود.

Migration باید:

User timezone را مشخص کند.

Taskهای موجود را بررسی کند.

از scheduledDate برای بازسازی dayKey در Taskهایی که timestamp معتبر دارند استفاده کند.

completedOn را در صورت امکان از timestamp completion بازسازی کند.

DailyPlanهای موجود را از کلید جلالی فعلی به کلید canonical جدید تبدیل کند.

collisionهای احتمالی را قبل از اعمال migration بررسی کند.

این migration نباید به SQL خام برای parsing جلالی متکی باشد؛ تبدیل تقویمی باید در Application Layer و با library معتبر انجام شود.

6.3.2 Lazy Rebalance Stale Detection

Final Decision

Version-based stale detection

به‌جای timestamp، از version counter استفاده می‌شود.

Stale Condition

stale ⇔

rebalancedVersion IS NULL

OR

planVersion > rebalancedVersion

Why Versioning?

Timestamp به‌تنهایی برای این مسئله کافی نیست.

به‌خصوص:

حذف Task ممکن است timestamp قابل مقایسه‌ای در خود Task باقی نگذارد.

mutation ممکن است روی چند entity اثر بگذارد.

Rebalance خودش نباید باعث ambiguity در تشخیص stale state شود.

Version دقیقاً بیان می‌کند که planner تا کدام state محاسبه شده است.

Mutation Rule

هر mutation مؤثر بر برنامه‌ی یک روز باید:

planVersion += 1

را روی DailyPlan مربوطه اعمال کند.

نمونه mutationها:

Create Task

Edit Task

Delete Task

Complete Task

Analyze Task، اگر نتیجه‌ی تحلیل روی planning اثر بگذارد

Rollover

تغییر availableMinutes

تغییر scheduling مؤثر روی آن روز

Multi-Day Mutation

اگر mutation یک Task روی بیش از یک روز اثر بگذارد، تمام روزهای affected باید stale شوند.

مثلاً:

2026-09-06 → 2026-09-07

باید وضعیت هر دو DailyPlan بررسی و در صورت وجود اثر، version آن‌ها update شود.

Rebalance Completion

پس از اجرای موفق Rebalance:

rebalancedVersion = planVersion

این تغییر باید در همان transaction مربوط به persistence نتیجه‌ی Rebalance انجام شود تا state به‌صورت ناسازگار باقی نماند.

Version Atomicity

هر افزایش planVersion باید در همان transaction خودِ mutation انجام شود. هدف: هیچوقت mutation بدون bump باقی نماند وگرنه stale detection از کار می‌افتد.

برای جلوگیری از lost update در درخواست‌های همزمان، increment باید اتمیک باشد:

SET planVersion = planVersion + 1

از read-modify-write غیراتمیک استفاده نشود.

6.3.3 DailyPlan Creation Policy

DailyPlan باید در صورت نیاز برای هر User/Day قابل ایجاد یا upsert باشد.

Mutationهایی که به یک روز اثر می‌گذارند نباید صرفاً به‌خاطر نبودن رکورد DailyPlan fail شوند.

Absence Semantics

نبود رکورد DailyPlan برای یک روز = آن روز stale است.

Creation Paths

۱) ایجاد در مسیر mutation:

اگر رکورد حین یک mutation ساخته شود، planVersion از 1 شروع می‌شود (همان mutation اولین bump است) و rebalancedVersion = null می‌ماند.

۲) ایجاد در مسیر read (initial read):

اگر رکورد صرفاً هنگام اولین read ساخته شود، می‌تواند با:

planVersion = 0

rebalancedVersion = 0

ایجاد شود و سپس در صورت نیاز Rebalance اجرا و rebalancedVersion هماهنگ شود.

API Ownership

مالکیت API و Service مربوط به:

create / update / upsert DailyPlan

تغییر availableMinutes

طبق Section 3 — System Architecture و ADR-02 تعریف می‌شود:

Route Handler = مرز HTTP

Business Logic در lib/

6.3.4 Computed Summary

در V1 summaryها persisted نمی‌شوند.

فیلدهای زیر به‌صورت دائمی روی DailyPlan اضافه نمی‌شوند:

spent

saved

committed

pool

...

این مقادیر هنگام read از state موجود محاسبه می‌شوند.

Source of Truth

Task.allocatedMinutes

Task.spentMinutes

Task.status

Task.scheduledDate / dayKey

DailyPlan.availableMinutes

بنابراین:

DailyPlan

↓

capacity + planning state

Task

↓

actual planning data

Summary

↓

computed from current state

این تصمیم از duplicate state و synchronization bugs جلوگیری می‌کند.

6.3.5 AI Analysis Invalidation

Two Mutation Classes

Mutationهای Task به دو کلاس تقسیم می‌شوند که اثر متفاوتی روی AI fields و stale state دارند:

A) Planning-only Mutations

نمونه‌ها:

Rollover

Reschedule / تغییر scheduled day

Complete

Delete

تغییر availableMinutes

این تغییرها محتوای Task را عوض نمی‌کنند، بنابراین:

AI analysis fields پاک نمی‌شوند:

score        → untouched

priority     → untouched

estimatedTime→ untouched

reason       → untouched

category نیز untouched است.

فقط planning state باید stale شود:

planVersion += 1

رویداد مناسب ثبت می‌شود:

ROLLED_OVER

COMPLETED

...

این عملیات‌ها در همان transaction انجام می‌شوند.

B) Content Mutations

نمونه‌ها:

تغییر متن Task

تغییر ماهیت / محتوای Task

در این حالت:

تحلیل قبلی AI دیگر معتبر فرض نمی‌شود.

فقط این فیلدهای AI null می‌شوند:

score          → null

priority       → null

estimatedTime  → null

reason         → null

category null نمی‌شود (فراداده‌ی کاربر است).

مقدار فعلی allocatedMinutes پاک نمی‌شود؛ تا اجرای Rebalance بعدی باقی می‌ماند و Rebalance بعدی allocation جدید را محاسبه می‌کند.

یک TaskEvent(type = EDITED) ثبت می‌شود.

planVersion روزهای affected افزایش می‌یابد.

همه‌ی این عملیات‌ها باید در یک transaction اتمیک انجام شوند.

Important Rule

این invalidation باید در همان transaction انجام شود.

هدف این است که سیستم هیچوقت وضعیت زیر را به‌عنوان state معتبر نگه ندارد:

New Task Text

+

Old AI Analysis

و هیچوقت mutation بدون bump نسخه یا بدون ثبت EDITED commit نشود.

Re-analysis

پس از invalidation:

Task exists

↓

AI fields = null

↓

User explicitly requests Analyze

↓

New AI result

↓

AI fields populated

AI همچنان optional است.

Future Extension

اگر در آینده UX نیاز داشته باشد که نتیجه‌ی قبلی با برچسب stale حفظ شود، این موضوع می‌تواند با textHash یا versioning تحلیل‌ها و یک ADR جدا طراحی شود.

در V1 چنین پیچیدگی‌ای اضافه نمی‌شود.

6.3.6 TaskEvent

TaskEvent یک Entity مستقل در سطح Domain نیست؛ زیرمجموعه‌ی Tasks است.

Target Model

enum TaskEventType {

CREATED

ANALYZED

EDITED

ROLLED_OVER

COMPLETED

}

model TaskEvent {

id        Int           @id @default(autoincrement())

taskId    Int

type      TaskEventType

createdAt DateTime      @default(now())

payload   Json?

task Task @relation(

fields: [taskId],

references: [id],

onDelete: Cascade

)

@@index([taskId, createdAt])

}

Event Types

V1:

CREATED

ANALYZED

EDITED

ROLLED_OVER

COMPLETED

نکات معنایی:

EDITED فقط در Content Mutation ثبت می‌شود.

Planning-onlyها رویداد مخصوص خود را دارند (ROLLED_OVER، COMPLETED و...).

لیست eventها extensible است.

Event جدید فقط زمانی اضافه شود که یک business event واقعی وجود داشته باشد؛ صرفاً برای logging فنی event ساخته نشود.

Payload

payload برای اطلاعات context-dependent و کوچک استفاده می‌شود.

مثلاً:

{

"fromDayKey": "2026-09-06",

"toDayKey": "2026-09-07"

}

یا:

{

"spentMinutes": 35

}

Payload نباید تبدیل به محل نگهداری source of truth اصلی Task شود.

Append-only Semantics

Eventها بعد از ایجاد update نمی‌شوند.

آنها نماینده‌ی رخدادهای گذشته هستند.

با این حال TaskEvent در V1 یک audit log دائمی کل سیستم نیست؛ چون relation آن با Task دارای:

onDelete: Cascade

است.

بنابراین حذف Task، eventهای مربوط به همان Task را نیز حذف می‌کند.

اگر در آینده audit دائمی یا compliance history لازم شد، باید storage/retention مستقل طراحی شود.

6.3.7 Deferred Models

مدل‌های زیر در V1 ساخته نمی‌شوند:

TaskAnalysis

TimeEntry

Habit

Notification

Reason

TaskAnalysis

AI result فعلاً state فعلی Task است و نیاز به history مستقل ندارد.

TimeEntry

Time Tracking فعال است، اما session-level history در V1 لازم نیست.

Actual duration:

Task.spentMinutes

ذخیره می‌شود.

Habit

Deferred feature.

Notification

Deferred feature.

این تصمیم‌ها جلوی premature modeling را می‌گیرند.

6.4 Implementation Gaps

موارد زیر Architecture Gap / Technical Debt هستند و صرفاً در این بخش ثبت می‌شوند؛ implementation آنها در implementation plan انجام خواهد شد.

1. AI در Create Task

در implementation فعلی ممکن است Create Task به‌صورت مستقیم AI را صدا بزند.

این با اصل زیر مغایرت دارد:

Task creation must not depend on AI.

Create Task باید بدون external AI service موفق شود.

2. Eager Rebalance

در implementation فعلی Rebalance ممکن است بعد از هر mutation اجرا شود.

این با ADR-03 مغایر است.

Target:

Mutation

↓

mark DailyPlan stale

↓

later read / planning request

↓

Rebalance if stale

3. Hardcoded Jalali / Tehran Logic

منطق فعلی تاریخ در jalali.ts به timezone و calendar خاص وابسته است.

این باید با مدل جدید تفکیک شود:

Timezone

↓

canonical local day

Calendar

↓

display formatting

4. Available Minutes API

در implementation فعلی route مشخصی برای تغییر availableMinutes وجود ندارد و فقط schema مربوط به day plan وجود دارد.

مالکیت API و Service مربوط به:

create / update / upsert DailyPlan

طبق Section 3 (System Architecture) و ADR-02 در implementation plan مشخص می‌شود.

5. Task Edit API

مطابق Architecture Gap ثبت‌شده در Section 5، route عمومی برای Edit Task باید ایجاد شود.

این route باید دو کلاس mutation را پیاده کند:

Content Mutation → invalidation گروه AI (score/priority/estimatedTime/reason) + ثبت EDITED + stale کردن روزهای affected

Planning-only → فقط stale کردن (بدون دست زدن به فیلدهای AI)

همه در یک transaction اتمیک.

6. Timezone Change Policy

V1 تغییر timezone را از UI پشتیبانی نمی‌کند.

اگر این قابلیت در آینده اضافه شود، تغییر timezone صرفاً یک تغییر ساده‌ی User field محسوب نمی‌شود و باید اثر آن روی daily boundaries و existing planning data بررسی شود.

7. بازنویسی category توسط AI در Analyze

در route فعلی analyze، category به‌صورت بی‌قیدوشرط از خروجی AI روی Task نوشته می‌شود.

طبق تصمیم ۶.۲.۲ (Category):

AI فقط در صورتی category را تنظیم کند که مقدار فعلی null باشد.

انتخاب صریح کاربر نباید بازنویسی شود.

6.5 Data Integrity Rules

هر Task متعلق به یک User است.

هر DailyPlan متعلق به یک User و یک canonical dayKey است.

برای هر User/Day حداکثر یک DailyPlan وجود دارد.

dayKey در persistence همیشه canonical Gregorian local date است.

calendar نباید روی مقدار persisted dayKey اثر بگذارد.

timezone مرجع تعیین local day است.

priority می‌تواند null باشد.

AI fields (score, priority, estimatedTime, reason) می‌توانند null باشند.

Task بدون AI Analysis معتبر است.

category فراداده‌ی Task است و در Content Mutation پاک نمی‌شود.

AI هرگز category انتخاب‌شده‌ی صریح توسط کاربر را بازنویسی نمی‌کند.

estimatedTime با spentMinutes یکی نیست.

allocatedMinutes با spentMinutes یکی نیست.

allocatedMinutes در Content Mutation پاک نمی‌شود و تا Rebalance بعدی باقی می‌ماند.

Summaryهای DailyPlan source of truth مستقل ندارند.

Rebalance فقط زمانی معتبر است که:

rebalancedVersion = planVersion

نبود رکورد DailyPlan = روز stale است (سمانتیک ایجاد مطابق ۶.۳.۳).

هر mutation مؤثر بر planning باید planVersion روز affected را در همان transaction و به‌صورت اتمیک افزایش دهد.

Content Mutation فقط score/priority/estimatedTime/reason را null می‌کند؛ category و allocatedMinutes untouched می‌مانند.

Planning-only mutation هرگز فیلدهای AI را null نمی‌کند و EDITED ثبت نمی‌کند.

Mutationهای چندروزه باید تمام روزهای affected را stale کنند.

TaskEvent بعد از ایجاد update نمی‌شود.

TaskEvent.payload source of truth اصلی Task نیست.

Content Mutation باید نتیجه‌ی AI قبلی را invalidate و EDITED را به‌صورت atomic ثبت کند.

هیچ Domain جدیدی برای Deferred features در V1 ساخته نشود.

6.6 Target Relationship Overview

Mental model:

User

├── Tasks

│    └── TaskEvents

│

└── DailyPlans

└── Rebalance State

و:

Task

├── AI Analysis State

│    ├── score

│    ├── priority

│    ├── estimatedTime

│    └── reason

│

├── Category

│    └── فراداده‌ی کاربر (AI فقط در صورت خالی بودن پیشنهاد می‌دهد)

│

├── Planning State

│    └── allocatedMinutes

│

└── Time Tracking

└── spentMinutes

AI Analysis در این مدل Entity مستقل نیست؛ state فعلی تحلیل روی Task است.

6.7 Final Database Decisions

6.8 Status

LOCKED

این Section، Source of Truth معماری Database در V1 است.

هر implementation جدید باید با این قراردادها سازگار باشد.

اگر implementation فعلی با این تصمیم‌ها اختلاف داشته باشد، اختلاف به‌عنوان:

Architecture Gap

یا:

Technical Debt

ثبت می‌شود و نباید با تغییر خاموش معماری حل شود.

تغییر در تصمیم‌های این بخش باید با بررسی اثرات آن و در صورت مهم بودن با ADR جدید انجام شود.

✅ بخش ۶ قفل شد

دو کلاس mutation (Planning-only / Content) وارد ۶.۳.۵، ۶.۵ و ۶.۷ شد.

category به فراداده‌ی کاربر تبدیل شد، از گروه invalidation خارج شد و Gap جدید (#7 بازنویسی category در route فعلی analyze) ثبت شد.

ارجاع‌های «Section 11 / API Architecture» به Section 3 + ADR-02 اصلاح شد.

سمانتیک نبودِ رکورد DailyPlan (۶.۳.۳) و atomic بودن bump نسخه اضافه شد؛ allocatedMinutes در Content Mutation حفظ می‌شود.

7. AI Architecture

7.0 نقش و اصول

در V1، AI فقط یک Analyzer / مشاور اختیاری است، نه Decision Maker و نه منبع حقیقت.

اصول حاکم

AI پیشنهاد می‌دهد؛ تصمیم نهایی با User و Rebalance Engine است.

هیچ Domain اصلی به AI وابسته نیست؛ Task بدون AI کاملاً معتبر است.

Create Task هرگز به AI وابسته نیست و نباید توسط آن block شود:

Create Task

↓

Database

↓

Task ساخته می‌شود

Analyze یک action مستقل است و فقط با درخواست صریح User اجرا می‌شود:

User → Analyze

↓

AI Layer

↓

Validate

↓

Save Analysis

فقط Taskهایی با وضعیت TODO قابلیت Analyze شدن دارند. این یک Product Rule در V1 است، نه Gap.

Taskهای IN_PROGRESS و DONE در V1 دوباره Analyze نمی‌شوند.

دلیل: وقتی کاربر وارد اجرای Task شده، تغییر مداوم تخمین یا اولویت AI در همان لحظه ارزش محدودی دارد و می‌تواند باعث بی‌ثباتی planning شود. اگر در آینده نیاز به Re-analysis برای IN_PROGRESS ایجاد شد، یک تصمیم محصولی/ADR جدا گرفته می‌شود.

شکست AI نباید Task یا Planning را خراب کند.

aiSchema تنها مرز قطعی و معتبر خروجی AI است؛ هیچ raw response مستقیم وارد Database نمی‌شود.

Provider قابل تعویض است؛ فقط لایه‌ی lib/ai اجازه‌ی شناخت Provider را دارد.

Analyze خودش Rebalance را اجرا نمی‌کند؛ فقط در صورت اثرگذاری، روز را stale می‌کند (Lazy طبق ADR-03).

Mock یک fallback واقعی و قابل استفاده است، اما نباید با تحلیل واقعی AI اشتباه گرفته شود و مصرف AI/سهمیه محسوب نمی‌شود.

AI هرگز category انتخاب‌شده‌ی صریح توسط کاربر را overwrite نمی‌کند.

AI Assistant / Coach در V1 وجود ندارد.

7.1 جایگاه در معماری

AI یک شاخه‌ی اختیاری (leaf) متصل به Task است (طبق 5.1) و هیچ Domain دیگری به آن وابسته نیست.

┌──────────────┐

│     User     │

└──────┬───────┘

│

Analyze

↓

┌────────────────┐

│   AI Layer     │

│                │

│ Provider       │

│ Schema/Zod     │

│ Retry/Timeout  │

│ Mock Fallback  │

└───────┬────────┘

↓

Valid AI Result

↓

Task

↓

DailyPlan becomes

stale

↓

Lazy Rebalance

مسئولیت‌ها جدا هستند:

AI Analysis ≠ Rebalance

7.2 اجزای AI Layer

پیاده‌سازی فعلی در app/lib/ai/:

Environment فعلی:

AIXAI_API_KEY      (نبودش → fallback به mock بدون خطا)

AIXAI_BASE_URL     (پیش‌فرض https://1xai.ir/v1)

AIXAI_MODEL        (پیش‌فرض deepseek-chat)

AI_MAX_ATTEMPTS    (پیش‌فرض 3)

AI_TIMEOUT_MS      (پیش‌فرض 12000)

این مقادیر «وضعیت فعلی» هستند؛ خود قرارداد، aiSchema است نه یک Provider مشخص.

7.3 قرارداد ورودی/خروجی

قرارداد خروجی (Zod)

score            عدد صحیح 0 تا 100 (اهمیت + فوریت)

priority         HIGH | MEDIUM | LOW

estimatedMinutes عدد صحیح 5 تا 480 دقیقه → ذخیره در Task.estimatedTime

reason           متن 1 تا 300 کاراکتر

category         متن 1 تا 30 کاراکتر (پیشنهاد؛ طبق قانون 7.5)

Schema مرز قطعی است

Provider raw response

↓

parseAiJson

↓

Zod validation (aiSchema)

↓

Typed AI result

↓

Task persistence

هیچ raw response مستقیماً وارد Database نمی‌شود.

اگر structure خروجی AI تغییر کند:

aiSchema

↓

implementation

↓

در صورت تغییر persistence

migration / ADR

بررسی می‌شود.

7.4 Trigger و قوانین Analyze

Analyze فقط با درخواست صریح User اجرا می‌شود؛ Create Task هرگز به‌صورت implicit باعث call به AI نمی‌شود.

فقط Taskهای TODO قابل Analyze هستند (Product Rule V1 — 7.0).

پس از Analyze موفق، خروجی معتبر روی Task ذخیره می‌شود و TaskEvent(type = ANALYZED) ثبت می‌شود (طبق Section 6).

7.5 قانون Category

AI فقط زمانی می‌تواند category را روی Task بنویسد که:

Task.category === null

اگر کاربر قبلاً category تعیین کرده باشد، AI نباید آن را overwrite کند.

بنابراین در Analyze:

score          → از AI

priority       → از AI

estimatedTime  → از AI

reason         → از AI

category       → فقط اگر مقدار فعلی null باشد

این قانون باید واقعاً در implementation اعمال شود.

7.6 Persistence و Invalidation

Analyze نتیجه را روی فیلدهای nullable Task می‌نویسد (Section 6).

Content Mutation → invalidation فقط گروه score/priority/estimatedTime/reason + ثبت EDITED (۶.۳.۵).

category و allocatedMinutes در Content Mutation untouched می‌مانند (۶.۳.۵).

Planning-only mutation هرگز فیلدهای AI را null نمی‌کند (۶.۳.۵).

7.7 Analyze ≠ Rebalance

Analyze نتیجه‌ی AI را ذخیره می‌کند و اگر نتیجه روی planning state اثر داشته باشد، روز را stale می‌کند:

Analyze

↓

planVersion++

↓

DailyPlan = stale

Rebalance در زمان مناسب و طبق سیاست Lazy (ADR-03 و Section 3) اجرا می‌شود.

در V1، تحلیل موفق به‌صورت پیش‌فرض planning-affecting در نظر گرفته می‌شود (چون score و estimatedTime را تغییر می‌دهد) و bump در همان transaction انجام می‌شود.

AI Analysis و Rebalance دو مسئولیت جدا هستند.

7.8 Failure و Degradation

اگر:

API timeout شود

Provider down باشد

response نامعتبر باشد

JSON خراب باشد

API key وجود نداشته باشد

Task همچنان معتبر است و AI فقط fail/degrade می‌شود.

در V1:

Real AI

↓ failure

Mock

↓

Valid structured result

Retry Policy

Retryable:

timeout

network error

408

429

5xx

→ exponential backoff + jitter

Non-retryable:

400

401

403

404

→ بدون retry

هدف: خطای permanent باعث retry بی‌دلیل و مصرف اضافه نشود.

Mock Fallback

در V1، Mock به‌عنوان fallback واقعی و قابل استفاده باقی می‌ماند، اما نباید با تحلیل واقعی AI اشتباه گرفته شود.

وقتی Provider در دسترس نیست یا API Key وجود ندارد:

source = "mock"

و سیستم همچنان می‌تواند نتیجه را به UI برگرداند.

UI باید به‌وضوح مشخص کند که نتیجه از Mock آمده است؛ مثلاً یک label ساده:

Mock / Demo Analysis

قانون مهم

Mock نباید به‌عنوان استفاده‌ی واقعی از AI یا مصرف سهمیه‌ی AI در نظر گرفته شود.

در آینده که AI gating اضافه شد:

User.plan

↓

API Authorization

↓

Real AI usage

و Mock fallback نباید باعث شود کاربر بدون دسترسی واقعی، مصرف AI واقعی محسوب شود.

7.9 Provider Abstraction و Gating آینده

کد Domain و Task نباید بداند که Provider فعلی چیست.

فقط:

lib/ai

اجازه دارد Provider را بشناسد.

اگر بعداً Provider عوض شد:

Provider A

↓

AI Contract (aiSchema)

↓

Provider B

Domain و Planning نباید تغییر کنند.

Gating (آینده)

V1: بدون گیت.

آینده: چک User.plan (FREE/PRO) در مرز API (Authorization)، نه در Domain (طبق Section 5).

تبدیل AI به ویژگی پولی نباید ساختار Task/Planning را تغییر دهد.

Entitlement / Quota در V1 Domain جدا نیستند.

7.10 AI منبع حقیقت نیست

AI فقط پیشنهاد می‌دهد.

مثلاً:

AI → estimatedTime = 60

این به این معنی نیست که سیستم موظف است دقیقاً 60 دقیقه برای Task اختصاص دهد.

Rebalance Engine همچنان مسئول planning است و می‌تواند بر اساس:

availableMinutes

سایر Taskها

score

estimatedTime

status

planning constraints

تصمیم نهایی را بگیرد.

7.11 آینده: AI Assistant / Coach — Deferred

در V1 وجود ندارد و به آینده موکول است.

پیش‌نیازهای آن:

TaskEvent history (در Section 6 ساخته شد)

planned vs actual مقایسه (spentMinutes)

textHash برای تشخیص stale (در صورت نیاز)

دسترس‌پذیری و context کاربر

قابلیت‌های آینده مانند:

AI Coach

context چندلایه

history-based analysis

personalized recommendations

quota / entitlement

فقط در صورت نیاز واقعی و با ADR جدا بررسی می‌شوند.

7.12 Implementation Gaps مربوط به AI

موارد زیر با این معماری در تناقض‌اند و باید در implementation plan اصلاح شوند:

1. بازنویسی بی‌قیدوشرط category

route فعلی analyze مقدار category را همیشه از AI می‌نویسد. طبق قانون 7.5 باید فقط وقتی Task.category === null باشد مقداردهی شود. (همان Gap #7 بخش 6.4)

2. Eager Rebalance بعد از Analyze

route فعلی analyze بلافاصله rebalanceDay را اجرا می‌کند. طبق 7.7 و ADR-03 باید فقط روز را stale کند و Rebalance را به زمان مناسب (Lazy) موکول کند. (همان Gap #2 بخش 6.4)

3. نبود TaskEvent در کد فعلی

ثبت ANALYZED / EDITED طبق Section 6 هنوز در کد وجود ندارد و باید همراه مدل TaskEvent اضافه شود.

7.13 AI V1 Contract (خلاصه)

AI در V1

Analyzer است، نه Decision Maker.

اختیاری است.

Create Task به AI وابسته نیست.

فقط با درخواست صریح کاربر اجرا می‌شود.

فقط TODO را Analyze می‌کند.

خروجی فقط بعد از Zod validation معتبر است.

Provider قابل تعویض است.

timeout/retry/backoff دارد.

Mock fallback دارد.

Mock از AI واقعی جدا قابل تشخیص است.

Mock مصرف AI واقعی/سهمیه محسوب نمی‌شود.

category فقط وقتی null باشد توسط AI مقداردهی می‌شود.

AI نباید category انتخاب‌شده‌ی کاربر را overwrite کند.

Analyze مستقیماً Rebalance نمی‌کند.

Analyze در صورت اثرگذاری روی planning، روز را stale می‌کند.

AI failure نباید Task یا Planning را خراب کند.

AI Assistant/Coach در V1 وجود ندارد و به آینده موکول است.

7.14 Status

LOCKED

این Section، Source of Truth معماری AI در V1 است.

پس از این تصمیم‌ها، وارد طراحی قابلیت‌های جدید AI نشو.

قابلیت‌های آینده مثل AI Coach، context چندلایه، history-based analysis، personalized recommendations و quota/entitlement فقط در صورت نیاز واقعی و با ADR جدا بررسی می‌شوند.

✅ بخش ۷ قفل شد

دو Gap مرتبط با کد فعلی هم ثبت شد (بازنویسی بی‌قیدوشرط category و Eager Rebalance در route تحلیل) که با Gapهای ۶.۴ همخوانی دارند.

وضعیت پیشرفت: ۷ از ۱۳ قفل شد — بخش‌های سنگین (۶ و ۷) تمام شدند. 🎉

8. Authentication & Security

8.0 Principles

Authentication & Security مسئول مدیریت هویت، Session و کنترل دسترسی است و نباید شامل Business Logic مربوط به Tasks، Daily Planning یا AI باشد.

اصول V1:

Authentication فقط مسئول Identity و Session است.

Route Handlerها از الگوی زیر پیروی می‌کنند:

Parse → Authenticate → Validate → Authorize → Service → Response

Identity کاربر از طریق JWT داخل httpOnly cookie مدیریت می‌شود.

getCurrentUser() به‌عنوان Identity Resolver در Server Components و Route Handlers قابل استفاده است.

تمام دسترسی به Resourceهای متعلق به User باید با userId احراز‌شده Scope شود.

Validation ورودی‌ها در مرز HTTP و با Zod انجام می‌شود.

Secretها و Credentialها هرگز نباید به Client ارسال شوند.

مدل Authorization در V1 فقط Ownership است؛ Role و Role-based access وجود ندارد.

Feature Gating آینده، مانند plan: FREE | PRO برای قابلیت‌های AI، در Authorization Boundary انجام می‌شود و نباید فقط در UI enforce شود.

8.1 Current Authentication Implementation

Routes

Authentication در V1 شامل Routeهای زیر است:

POST /api/auth/register

POST /api/auth/login

POST /api/auth/logout

GET /api/auth/profile

PATCH /api/auth/profile

GET /api/auth/me در V1 وجود ندارد.

Current getCurrentUser()

lib/getCurrentUser.ts فقط مسئول Identity Resolution است:

دریافت token از Cookie

Verify کردن JWT با JWT_SECRET

استخراج User ID

دریافت اطلاعات User موردنیاز از Database

برگرداندن User Identity یا null

getCurrentUser() نباید Business Logic مربوط به Domainهای دیگر را انجام دهد.

اطلاعات Password نباید توسط getCurrentUser() Query شوند و در Identity Resolution نیازی به دریافت Password Hash وجود ندارد.

در صورت Token نامعتبر یا User ناموجود → null.

Middleware

در V1 از middleware.ts برای Authentication استفاده نمی‌شود.

Protection در سطح Route Handler و با getCurrentUser() انجام می‌شود.

این تصمیم عمدی است تا Authentication و Authorization به‌صورت صریح در Boundary هر API قابل مشاهده باشند.

8.2 Registration

Endpoint

POST /api/auth/register

Rules

Rate Limit:

register:ip

حداکثر 5 requests / hour برای هر IP

Validation با Zod:

username حداقل 3 کاراکتر

email معتبر

password حداقل 8 کاراکتر

password confirmation باید match باشد

Password با bcrypt hash می‌شود.

bcrypt cost در V1 برابر 12 است.

Email باید Unique باشد.

Duplicate email → 409 Conflict

پاسخ موفق → 201 Created

User Defaults

مقادیر پیش‌فرض User باید از Prisma Schema اعمال شوند:

plan = FREE

timezone = Asia/Tehran

locale = fa

calendar = JALALI

بنابراین Route Registration نباید مسئول مقداردهی دستی این Defaultها باشد.

Auto Login

بعد از Registration موفق، کاربر در همان Flow به‌صورت خودکار Login می‌شود.

Session Creation باید از یک Helper مشترک مانند createSession() استفاده کند تا منطق ساخت JWT و Cookie بین Register و Login تکرار نشود.

8.3 Login & Session

Endpoint

POST /api/auth/login

Rate Limiting

دو Rate Limit فعال است:

IP-based:

login:ip

10 requests / 15 minutes

Email-based:

login:email

5 requests / 15 minutes

IP Rate Limit می‌تواند قبل از خواندن Body بررسی شود.

Email Rate Limit برای کارکردن به Email موجود در Body نیاز دارد؛ بنابراین در این بخش خاص ممکن است Validation ورودی قبل از اعمال Email-based Rate Limit انجام شود.

این یک Exception اجرایی است و ترتیب کانونی Authentication Architecture همچنان همان:

Parse → Authenticate → Validate → Authorize → Service → Response

Authentication

Login:

دریافت و Parse Request

بررسی Rate Limit مربوط به IP

Authentication با User و Password

در صورت نیاز بررسی Email-based Rate Limit

ساخت JWT در صورت موفقیت

قرار دادن JWT در httpOnly cookie

برای جلوگیری از User Enumeration، خطای User ناموجود و Password اشتباه باید پیام یکسانی داشته باشند.

Session Model — V1

Session در V1 به شکل زیر است:

یک JWT

Expiration = 7 days

بدون Refresh Token

بدون Server-side Session Store

بدون Token Revocation

Logout با حذف Cookie انجام می‌شود.

Cookie:

name: token

httpOnly: true

secure: NODE_ENV === "production"

sameSite: lax

maxAge: 7 days

path: /

JWT payload فعلی:

{id, email}

Logout Limitation

به دلیل Stateless بودن JWT، Logout در V1 فقط Cookie سمت Client را حذف می‌کند.

اگر Token قبلی خارج از Browser باقی مانده باشد، تا زمان Expiration خود JWT از نظر Server معتبر خواهد بود.

این رفتار برای V1 پذیرفته شده است.

Refresh Token و Revocation در صورت نیاز آینده، مخصوصاً در صورت اضافه‌شدن Payment/PRO، باید با تصمیم و ADR جداگانه طراحی شوند.

8.4 Identity Resolution

getCurrentUser() تنها مسئول Resolve کردن Identity است.

Flow:

Cookie

↓

JWT Verify

↓

User ID

↓

Database Lookup

↓

Authenticated User

در شرایط زیر نتیجه null است:

Token وجود ندارد

Token invalid است

Token expired است

User مربوط به Token وجود ندارد

Route Handler در این حالت باید 401 Unauthorized برگرداند.

اگر JWT_SECRET در Environment وجود نداشته باشد، این یک Configuration Error است و Server باید Fail Fast کند؛ این وضعیت نباید مانند یک کاربر unauthenticated تفسیر شود.

8.5 Profile & User Data

مسیر:

/api/auth/profile

از نظر HTTP زیر Authentication قرار دارد، اما Domain آن Users است.

GET

فقط اطلاعات safe و غیرحساس User برگردانده می‌شود.

Password Hash هرگز نباید Query یا Response شود.

PATCH

در V1 امکان تغییر این فیلدها وجود دارد:

username

firstName

lastName

phone

birthDate

Username باید Unique باشد و در صورت Conflict پاسخ 409 داده شود.

Email

تغییر Email در V1 پشتیبانی نمی‌شود.

این تصمیم با Deferred بودن Email Verification هماهنگ است.

Timezone

تغییر Timezone از طریق Profile API در V1 پشتیبانی نمی‌شود.

این با تصمیم Section 6 هماهنگ است که Timezone UI change را برای V1 خارج از Scope قرار داده است.

8.6 Validation

تمام ورودی‌های HTTP باید قبل از ورود به Service Layer Validation شوند.

V1 از Zod استفاده می‌کند.

Schemaهای Validation در ساختار فعلی پروژه در:

app/schema/formSchema.ts

قرار دارند.

اصل معماری:

Request

↓

Parse

↓

Authenticate

↓

Validate

↓

Authorize

↓

Service

↓

Response

این همان ترتیب کانونی تعریف‌شده در Section 3 است.

در برخی Flowهای خاص، مانند Email-based Login Rate Limiting، ممکن است برای استخراج داده موردنیاز Rate Limit، Validation ورودی زودتر انجام شود. این Exception ترتیب کانونی معماری را تغییر نمی‌دهد.

Validation نباید صرفاً در Client انجام شود.

Client-side validation می‌تواند برای UX وجود داشته باشد، اما Server-side validation منبع نهایی اعتبارسنجی ورودی است.

8.7 Rate Limiting

Rate Limiting در V1 با In-Memory Store پیاده‌سازی می‌شود.

Implementation فعلی از Map در lib/rateLimit.ts استفاده می‌کند.

Active Limits

IP فعلاً از x-forwarded-for استخراج می‌شود.

V1 Limitation

In-Memory Rate Limiting فقط برای Single-Instance deployment قابل اتکا است.

در Multi-Instance، Serverless یا محیط Distributed، هر Instance ممکن است State جداگانه داشته باشد.

فعلاً این محدودیت برای V1 پذیرفته شده است.

در صورت نیاز به Production-grade Distributed Rate Limiting، استفاده از Redis یا External Store باید با ADR جداگانه تصمیم‌گیری شود.

8.8 Authorization & Ownership

Authorization در V1 بر اساس Ownership است.

هر Resource متعلق به User باید فقط در Scope همان User قابل دسترسی باشد.

الگوی صحیح:

Authenticated User

↓

userId

↓

Service / Data Layer

↓

Resource Query scoped by userId

مثلاً:

find Task

WHERE id = taskId

AND userId = authenticatedUser.id

Ownership نباید فقط در UI بررسی شود.

Authorization باید در Service/Data Layer enforce شود تا Client نتواند با تغییر Request به Resource کاربر دیگر دسترسی پیدا کند.

Future Plan Gating

در آینده اگر Featureهایی فقط برای PRO فعال شوند:

Authenticate

↓

Authorize

↓

Check User.plan

↓

Service

کاربر FREE در صورت تلاش برای استفاده از Feature محدود باید 403 Forbidden دریافت کند.

وقتی Plan Gating فعال شود، Identity/Profile data موردنیاز برای Authorization و UI باید شامل plan نیز باشد تا Client بتواند وضعیت Plan کاربر را نمایش دهد.

8.9 CSRF

V1 از موارد زیر استفاده می‌کند:

httpOnly Cookie

sameSite=lax

Same-Origin API

عدم پشتیبانی از CORS عمومی

برای V1 این سطح از CSRF protection پذیرفته می‌شود.

اگر در آینده APIهای Cross-Origin، Third-Party Client یا CORS عمومی اضافه شوند، مدل CSRF باید دوباره بررسی شود.

8.10 Secrets & Server Security

Secretها فقط باید در Server Environment وجود داشته باشند.

نمونه‌ها:

JWT_SECRET

AIXAI_API_KEY

Client نباید به Secretهای Server دسترسی داشته باشد.

همچنین Prisma و Database Credentialها نباید وارد Client Bundle شوند.

External AI Provider نیز فقط از طریق lib/ai قابل دسترسی است و API Key نباید در Browser قرار گیرد.

8.11 Password Security

Password خام هرگز ذخیره نمی‌شود.

تنها Password Hash در Database نگهداری می‌شود.

V1 از bcrypt با cost 12 استفاده می‌کند.

password و passwordHash نباید در API Response برگردانده شوند.

bcrypt Native Dependency

به دلیل Native بودن bcrypt، Deployment Environment باید Build Tooling مناسب داشته باشد.

اگر در آینده محیط Deployment با Native Dependencyها مشکل داشته باشد، جایگزینی با bcryptjs می‌تواند به‌عنوان یک Technical Decision مستقل بررسی شود.

8.12 Deferred Authentication Features

موارد زیر در V1 پیاده‌سازی نمی‌شوند:

Email Verification

Password Reset

Password Change

Refresh Token

Token Revocation

Server-side Session Store

Production-grade Distributed Rate Limiting

Role-based Authorization

دلیل

این قابلیت‌ها یا به Email Provider نیاز دارند، یا Complexity مربوط به Session/Security را افزایش می‌دهند، بدون اینکه برای Scope فعلی Product ضروری باشند.

Password Change نیز تا زمان تعریف دقیق Flow امنیتی آن، از V1 خارج است.

8.13 Architecture Gaps / Implementation Tasks

موارد زیر باید در Implementation مطابق Architecture اصلاح یا بررسی شوند:

Auto-login بعد از Registration

استخراج Session Creation به Helper مشترک مانند createSession()

اطمینان از اعمال Prisma Defaults برای:

plan

timezone

locale

calendar

حفظ Ownership Scoping در تمام Resource Queryها

اطمینان از عدم Query/Return شدن Password Hash

انتقال Authorization واقعی به Service/Data Layer

حفظ Rate Limitهای فعلی در V1

عدم اضافه‌کردن Middleware مگر اینکه نیاز معماری مشخصی ایجاد شود

عدم اضافه‌کردن Refresh Token یا Revocation در V1

عدم اجازه تغییر Timezone از Profile API در V1

عدم اجازه تغییر Email در Profile API در V1

در صورت فعال‌شدن Plan Gating، اطمینان از در دسترس بودن plan در Identity/Profile data موردنیاز Client و Authorization

8.14 Authentication & Security V1 Contract

قرارداد نهایی Authentication & Security در V1:

JWT-based authentication

JWT داخل httpOnly Cookie

JWT expiration = 7 days

بدون Refresh Token

بدون Server-side Session Store

بدون Revocation

Logout با حذف Cookie

Auto-login بعد از Registration

Session Creation از Helper مشترک

Identity Resolution با getCurrentUser()

Route-level Authentication

بدون Middleware در V1

Ownership-based Authorization

userId باید در Resource Access enforce شود

Zod Validation در HTTP Boundary

Password با bcrypt cost 12

Password Hash هرگز در Response

Register Rate Limit = 5/hour/IP

Login IP Rate Limit = 10/15min

Login Email Rate Limit = 5/15min

Rate Limit فعلاً In-Memory

Distributed Rate Limit deferred

CSRF strategy بر اساس SameSite + Same-Origin

Secretها فقط Server-side

Plan gating آینده در Authorization Boundary

Email Verification deferred

Password Reset deferred

Password Change deferred

Refresh/Revocation deferred

Role-based Authorization deferred

Email Change deferred

Timezone Change deferred

8.15 Status

LOCKED

این Section منبع حقیقت معماری برای Authentication & Security در V1 است.

هر تفاوت بین Implementation و این Section باید به‌عنوان Architecture Gap یا Technical Debt ثبت و اصلاح شود.

هر تغییر مهم در Session Model، Authorization Model، Password Security یا Security Boundary باید با Decision/ADR مستقل انجام شود.

9. Error Handling Strategy

9.0 Principles

Error Handling در DailyPilot بخشی از Architecture است و هدف آن این است که خطاها در مرز HTTP به‌صورت قابل پیش‌بینی، قابل فهم و قابل پردازش توسط Client مدیریت شوند.

اصول V1:

API باید HTTP Status Code مناسب برگرداند.

تمام API Responseها باید از Standard Response Envelope مطابق ADR-04 استفاده کنند.

Validation در HTTP Boundary و با Zod انجام می‌شود.

Authentication Failure با 401 Unauthorized پاسخ داده می‌شود.

Resource ناموجود یا Resource خارج از Ownership با 404 Not Found پاسخ داده می‌شود.

Conflict با 409 Conflict پاسخ داده می‌شود.

Rate Limit با 429 Too Many Requests پاسخ داده می‌شود.

خطاهای غیرمنتظره Database یا Server باید Log شوند و با 500 Internal Server Error و پیام عمومی پاسخ داده شوند.

جزئیات داخلی Database، Stack Trace، Secret یا اطلاعات حساس نباید در Response به Client نشت کند.

AI Failure نباید باعث شکست Task Creation یا Daily Planning شود و مطابق Section 7 باید به Mock Degradation منجر شود.

عملیات Client باید در صورت نیاز Loading، Error و Retry مناسب داشته باشند.

Offline در V1 فقط شامل تشخیص وضعیت، نمایش Indicator و Retry دستی است و Offline Mutation Queue و Automatic Sync در V1 وجود ندارد.

9.1 Error Handling at HTTP Boundary

Route Handlerها مسئول مدیریت خطا در مرز HTTP هستند، اما نباید محل Business Logic باشند.

الگوی کلی همچنان مطابق Section 3 است:

Parse

→ Authenticate

→ Validate

→ Authorize

→ Service

→ Response

Error Handling باید با این معماری هماهنگ باشد و باعث انتقال Business Logic به Route Handler نشود.

Route Handler باید:

ورودی را Parse کند.

Authentication را بررسی کند.

ورودی را Validate کند.

Ownership/Authorization را بررسی کند.

Service مربوطه را صدا بزند.

نتیجه را با Standard Response Envelope برگرداند.

خطاهای قابل پیش‌بینی را به Status و Error Code مناسب تبدیل کند.

خطاهای غیرمنتظره را Log کند و Response عمومی برگرداند.

Business Logic نباید برای مدیریت HTTP Status Code یا Response Shape به Route Handler وابسته شود.

9.2 Standard API Response Envelope

تمام API Responseهای DailyPilot باید مطابق ADR-04 در Section 3 باشند.

Success Response

{

ok: true,

data: ...

}

data شامل نتیجه‌ی موفقیت‌آمیز عملیات است.

در صورت نیاز می‌توان Message اختیاری نیز در Success Response اضافه کرد، اما شکل اصلی Response همچنان باید با ADR-04 سازگار باشد.

Error Response

{

ok: false,

error: {

code: "VALIDATION_ERROR",

message: "اطلاعات نامعتبر است",

errors: {...}

}

}

قواعد:

ok در تمام Responseها وجود دارد.

code یک شناسه‌ی پایدار و Machine-readable است.

Client نباید برای منطق برنامه به متن message وابسته باشد.

message در V1 فارسی است.

در آینده می‌توان بر اساس code و User locale، Internationalization اضافه کرد.

errors اختیاری است و عمدتاً برای Validation Error استفاده می‌شود.

Section 9 نباید Envelope جدید یا متفاوتی از ADR-04 تعریف کند.

9.3 Error Categories

Errorهای اصلی V1:

Validation — 400

وقتی Input معتبر نباشد:

HTTP 400

با:

code = VALIDATION_ERROR

Validation باید در HTTP Boundary و با Zod انجام شود.

در صورت امکان، جزئیات Validation در errors قرار می‌گیرد تا Client بتواند Field-specific Error نمایش دهد.

Authentication — 401

وقتی User احراز هویت نشده باشد:

HTTP 401

با:

code = UNAUTHORIZED

این Error نباید اطلاعاتی درباره‌ی علت داخلی Authentication Failure افشا کند.

Not Found / Ownership — 404

اگر Resource وجود نداشته باشد یا متعلق به User دیگری باشد:

HTTP 404

با:

code = NOT_FOUND

DailyPilot در V1 برای Ownership Failure از 403 استفاده نمی‌کند.

این تصمیم برای جلوگیری از افشای وجود Resource متعلق به User دیگر است.

Conflict — 409

برای Conflictهای قابل تشخیص، مانند Duplicate Resource یا Unique Constraint:

HTTP 409

با:

code = CONFLICT

برای مثال، Duplicate Email یا Username در Registration باید 409 باشد.

Rate Limit — 429

در صورت عبور از Rate Limit:

HTTP 429

با:

code = RATE_LIMITED

پیام باید برای User قابل فهم باشد و جزئیات داخلی Rate Limiting را افشا نکند.

Internal Error — 500

خطاهای غیرمنتظره‌ای که قابل دسته‌بندی یا مدیریت مشخص نیستند:

HTTP 500

با:

code = INTERNAL

Client نباید جزئیات داخلی Exception، Database Error، Stack Trace یا Infrastructure را دریافت کند.

Server باید Error را Log کند.

9.4 Database Error Handling

Known Database Errors باید در صورت امکان به Error Category مناسب Mapping شوند.

برای مثال:

Prisma P2002

→ Unique Constraint Violation

→ HTTP 409

→ CONFLICT

Unknown Database Errors نباید با جزئیات داخلی به Client ارسال شوند.

رفتار عمومی:

Database Error

→ Log

→ Generic 500 Response

→ INTERNAL

Database Error Mapping بخشی از Error Handling است، اما نباید Business Logic را وارد Route Handler کند.

9.5 AI Error Handling

AI Architecture مطابق Section 7 است.

AI یک External Dependency است و نباید Source of Truth یا نقطه‌ی شکست Core Domain باشد.

در Analyze:

User requests Analyze

↓

AI Provider

↓

Success → Validate with aiSchema → Persist

↓

Failure

↓

Retry if retryable

↓

Mock Fallback

Failureهای قابل انتظار شامل مواردی مانند:

Timeout

Network Failure

Invalid Provider Response

Invalid JSON

Missing Required Fields

Retryable HTTP Errors

هستند.

Retry برای خطاهای Retryable مطابق Section 7 انجام می‌شود.

در صورت شکست نهایی، Mock Fallback استفاده می‌شود.

AI Failure نباید:

Task Creation را خراب کند.

Core Task Data را از بین ببرد.

Daily Planning را متوقف کند.

باعث وابستگی Business Logic به Provider شود.

Mock Result باید در UI قابل تشخیص باشد و با:

source = "mock"

از Real AI Result متمایز شود.

9.6 Client Error Handling

Client باید برای عملیات Network/Server state مناسب داشته باشد.

Loading State

در زمان انتظار Request، UI باید وضعیت Loading مناسب داشته باشد.

برای عملیات مهم می‌توان از Spinner، Skeleton یا Disabled State استفاده کرد.

Error State

در صورت Failure، UI باید Error قابل فهم نمایش دهد.

Error State مناسب برای عملیات مهم نباید صرفاً با Toast جایگزین شود.

Retry

برای خطاهای موقتی یا Network Failure، Client باید در صورت امکان Retry دستی ارائه دهد.

Retry باید با احتیاط انجام شود تا باعث Duplicate Mutation نشود.

Toast

react-toastify می‌تواند برای Feedback غیرمسدودکننده استفاده شود.

Toast برای اطلاع‌رسانی کوتاه مناسب است، اما نباید جایگزین Error State لازم برای عملیات مهم شود.

9.7 Offline Strategy

DailyPilot در V1 Offline-capable به معنای کامل نیست.

Service Worker نباید API یا RSC Responseها را به‌صورت ناخواسته Cache کند.

در V1:

Online

↓

Normal Request

Offline

↓

Request may fail

↓

Show Offline State

↓

Manual Retry

قابلیت‌های V1:

تشخیص Offline/Online

نمایش Offline Indicator

نمایش وضعیت مناسب هنگام شکست Request

Retry دستی پس از برگشت Connection

Offline Mutation Queue

در V1 وجود ندارد.

DailyPilot در V1:

Mutation را به‌صورت Offline در Queue ذخیره نمی‌کند.

Automatic Sync ندارد.

Conflict Resolution برای Offline Sync ندارد.

Persistent Mutation Queue ندارد.

وجود UIهایی مانند:

.dp-offline-chip

.dp-queued-chip

به‌تنهایی به معنی وجود Offline Queue واقعی نیست.

اگر در Implementation Queue واقعی وجود نداشته باشد، Architecture نیز نباید آن را به‌عنوان قابلیت موجود مستند کند.

Offline Queue و Sync در آینده، در صورت نیاز واقعی، باید به‌صورت یک Feature/Architecture Decision مستقل طراحی شوند و مواردی مانند Persistence، Ordering، Retry، Duplicate Mutation و Conflict Resolution را مشخص کنند.

9.8 Logging

Logging در V1 ساده نگه داشته می‌شود.

در حال حاضر:

console.error(...)

در سطح Route برای Error Logging کافی است.

قواعد:

Unexpected Errorها باید Log شوند.

Sensitive Data نباید Log شود.

Password، JWT Secret، API Key و اطلاعات حساس User نباید در Log قرار گیرند.

Stack Trace و جزئیات داخلی نباید به Client Response منتقل شوند.

Centralized Logging و Observability در V1 وجود ندارد.

در آینده، در صورت نیاز ناشی از Production Scale یا Observability، می‌توان سیستم Logging/Monitoring متمرکز اضافه کرد.

این تغییر باید با Decision/ADR مستقل انجام شود.

9.9 Current Implementation State

وضعیت فعلی Implementation شامل موارد زیر است:

بسیاری از Routeها Error Handling و try/catch محلی دارند.

Routeها در حال حاضر Responseهای خود را به‌صورت مستقل می‌سازند.

Shared Response/Error Helper به‌صورت کامل وجود ندارد.

برخی Error Messageها فارسی و برخی انگلیسی هستند.

Errorهای شناخته‌شده Prisma هنوز به‌صورت یکپارچه Mapping نمی‌شوند.

console.error در سطح Route برای Logging استفاده می‌شود.

Client دارای برخی UI Indicatorهای مرتبط با Offline است، اما Offline Mutation Queue واقعی نباید بدون بررسی Implementation فرض شود.

این موارد Current State هستند و در صورت تفاوت با Target Architecture باید به‌عنوان Architecture Gap یا Technical Debt ثبت شوند.

9.10 Architecture Gaps / Implementation Tasks

موارد اصلی برای Alignment با این Section:

ایجاد یا یکسان‌سازی Shared Response Helper برای Standard Envelope.

یکسان‌سازی تمام API Responseها با ADR-04.

اضافه کردن ok به تمام Responseهای API.

اضافه کردن Machine-readable error.code.

یکسان‌سازی Error Messageها در V1 به فارسی.

ایجاد Mapping مناسب برای Known Prisma Errors.

بررسی و یکسان‌سازی Client Error Handling.

بررسی دقیق Offline UI و اطمینان از اینکه UI وجود Offline Queue واقعی را ادعا نمی‌کند.

بررسی Retry در Client برای جلوگیری از Duplicate Mutation.

حذف یا اصلاح Responseهای فعلی که خارج از Standard Envelope هستند.

این موارد Implementation Tasks هستند و نباید باعث تغییر در Domain Architecture شوند.

9.11 Error Handling and Architecture Boundaries

Error Handling باید مرزهای معماری را حفظ کند.

وابستگی مفهومی:

Client

↓

Route Handler

↓

Service / Domain

↓

Prisma / External Services

Error باید در مناسب‌ترین Layer تبدیل یا مدیریت شود.

Route Handler مسئول HTTP semantics است.

Service/Domain مسئول Business Rules است.

Database/Infrastructure مسئول Errorهای زیرساختی است.

AI Provider مسئول Provider-specific Failure است و این جزئیات نباید وارد Domain شوند.

به‌خصوص:

Business Logic نباید به HTTP Response Shape وابسته شود.

Domain نباید به Prisma Error Code وابسته شود.

Domain نباید به AI Provider Error Format وابسته شود.

Client نباید به متن Error Message وابسته شود.

Route Handler نباید محل Business Logic شود.

9.12 Future Considerations

موارد زیر در V1 فعال نیستند و فقط در صورت نیاز واقعی می‌توانند در آینده بررسی شوند:

Centralized Logging

Production Observability

Error Monitoring

Distributed Rate Limiting

Offline Mutation Queue

Automatic Offline Sync

Conflict Resolution

Advanced Retry Policies

Full Error Localization / i18n

More granular Error Codes

هر تغییر معماری مهم در این موارد باید با Decision/ADR مستقل انجام شود.

9.13 Final Decision Summary

9.14 Status

LOCKED

Section 9 منبع حقیقت معماری برای Error Handling در DailyPilot V1 است.

هر تفاوت بین Implementation و این Section باید به‌عنوان Architecture Gap یا Technical Debt ثبت و در Implementation Plan مدیریت شود.

تغییرات مهم در API Envelope، Error Model، Offline Sync، Logging/Observability یا Failure Strategy باید با Decision/ADR مستقل انجام شوند.

10. Structure & Architectural Boundaries

10.0 اصل حاکم

این Section ساختار معماری را Lock می‌کند، نه File Layout پروژه را.

معماری تعیین می‌کند که چه لایه‌ها/مرزهایی وجود دارند و هرکدام چه مسئولیتی دارند.
تعداد Componentها، نام فایل‌ها، نام کامپوننت‌ها، تعداد زیرپوشه‌ها و ترتیب فایل‌ها جزء Architecture نیستند و می‌توانند در Refactoring تغییر کنند.

قاعده‌ی کلیدی:
جزئیات File Layout و Component Organization بخشی از Implementation هستند و می‌توانند در Refactoring تغییر کنند، بدون اینکه Architecture تغییر کرده باشد؛ مشروط بر اینکه مرزهای معماری و مسئولیت‌های تعریف‌شده حفظ شوند.

10.1 مرزهای معماری (Architectural — قابل Lock)

قواعد مرزی

Route Handler فقط HTTP semantics دارد؛ Business Logic داخل آن نمی‌رود.

Server Components می‌توانند مستقیم از Server-side Business Logic بخوانند (ADR-01).

Client Components فقط از طریق HTTP Boundary با سرور ارتباط برقرار می‌کنند.

Domain Boundaries (Section 5) باید در لایه‌ی Server-side قابل تشخیص بمانند.

افزودن لایه/مرز جدید بدون دلیل معماری انجام نشود.

Domain Logic به UI، HTTP یا AI Provider وابسته نشود (Section 5/11).

Ownership-scoping (userId) در لایه‌ی دسترسی داده enforce شود (Section 8).

10.2 ساختار فعلی — Snapshot Implementation (نه الزام معماری)

ساختار زیر صرفاً وضعیت فعلی Implementation را نشان می‌دهد و الزامی نیست:

root/

├── app/            # (Next.js App Router)

│   ├── api/        # HTTP Boundary

│   ├── components/ # UI Boundary

│   ├── lib/        # Server-side Business / Infrastructure

│   │   ├── ai/     # AI Boundary

│   │   └── planner/# Planner Boundary

│   └── schema/     # Validation Boundary

├── prisma/         # Persistence

├── public/         # Static / PWA

└── architecture.md # Source of Truth

این Snapshot ممکن است با Refactor تغییر کند (جابه‌جایی، ادغام یا تفکیک فایل‌ها و زیرپوشه‌ها) بدون تغییر این Section — تا وقتی مرزهای ۱۰.۱ حفظ شوند.

10.3 آزادی Refactoring

Refactorهای زیر بدون نیاز به تغییر Architecture مجازند:

جابه‌جایی فایل‌ها بین زیرپوشه‌ها

تغییر نام فایل‌ها و کامپوننت‌ها

Split یا Merge کردن Componentها

انتقال Component به Feature Folder

تغییر سازماندهی داخلی یک لایه

مثال‌ها:

components/TaskCard.tsx

→ components/tasks/TaskCard.tsx

یا Merge چند Component در یک Component

یا Split یک Component به چند Component

چه زمانی Refactor نیاز به بررسی معماری دارد؟

اگر Refactor باعث تغییر مسئولیت یک لایه یا شکستن یک Architectural Boundary شود (مثلاً ورود Business Logic به UI، دسترسی Client به Prisma/Secret، یا نشت Domain Logic به Route Handler)، آنگاه Architecture باید بررسی و در صورت نیاز با Decision/ADR تغییر کند.

10.4 Styling

جزئیات چیدمان استایل (محل فایل‌های CSS، colocation یا نبودنش) جزء Implementation است.

تصمیم معماری Styling در Section 4 ثبت شده:

Custom CSS + Design Tokens — بدون Tailwind

این تصمیم با Refactor فایل‌ها تغییر نمی‌کند.

10.5 Status

LOCKED

این Section مرزها و مسئولیت‌های معماری را Lock می‌کند، نه File Layout را.

به‌روزرسانی این Section فقط در صورت تغییر واقعی یک مرز/مسئولیت معماری (با ADR) انجام می‌شود؛ تغییرات صرفاً سازماندهی فایل‌ها هرگز دلیل به‌روزرسانی این Section نیست.

11. Development Rules

قوانین توسعه V1 — Contract معماری. LOCK بودن این بخش به معنی کامل بودن Implementation نیست؛
Implementation باید در نهایت با این Contract منطبق شود و اختلاف‌ها به‌عنوان Gap ثبت شوند.

11.1 Code Structure

کامپوننت‌ها کوچک و Single Responsibility باشند.

Business Logic داخل Client Component قرار نمی‌گیرد.

Route Handlerها Thin باقی می‌مانند — الگوی:
Parse → Authenticate → Validate → Authorize → Service → Response

Client به Prisma یا Server Secrets دسترسی ندارد.

TypeScript زبان اصلی پروژه است (Type Safety در کل پروژه).

Validation در HTTP Boundary با Zod انجام می‌شود.

Resource Access باید Ownership-scoped باشد (userId).

Shared Helpers فقط با مسئولیت مشخص ایجاد شوند؛ نباید به مخزن Business Logic مبهم تبدیل شوند.

11.2 Domain Rules

Task به AI وابسته نیست (Section 5).

AI Analyzer/Advisor است، نه Source of Truth (Section 7).

Rebalance Pure و Idempotent است و در V1 Lazy/On-Demand است (ADR-03).

Mutationهای Planning باید Versioning/Stale mechanism (Section 6) را رعایت کنند.

روز کاربر بر اساس Timezone تعیین می‌شود؛ Calendar فقط Presentation است (Section 6).

TaskEvent زیرمجموعه Tasks است.

Time Tracking با spentMinutes روی Task؛ TimeEntry مستقل در V1 نیست.

Domain Logic به UI، HTTP یا AI Provider وابسته نمی‌شود.

11.3 Change Rules

تغییرات مهم معماری باید ADR داشته باشند و Silent نباشند.

تفاوت Implementation با Architecture = Architecture Gap / Technical Debt — نه تغییر خاموش.

Refactor رفتار موجود را بدون تغییر غیرضروری حفظ کند.

Feature جدید بدون بررسی اثر بر Domain/Database/Security/Deployment وارد نشود.

11.4 Tooling Gaps (Implementation Gap — نه Decision)

Test Framework وجود ندارد.

اسکریپت‌های test / typecheck / db:* در package.json غایب‌اند.

اینها Gap هستند؛ بدون نیاز واقعی Dependency/Tool جدید اضافه نمی‌شود.

11.5 Status

LOCKED — به‌عنوان Contract معماری.

12. Deployment Architecture

12.0 V1 Deployment Model

User (Browser / PWA)

↓ HTTPS

Next.js Application (Node.js Runtime)

↓

PostgreSQL

↓

External AI Provider

در V1 فقط AI Provider سرویس خارجی فعال است. Email/Storage/Payment جزء Deployment فعال V1 نیستند.

12.1 V1 Deployment Assumptions

Single Instance — In-memory Rate Limiting فقط در Single Instance قابل اتکاست (Section 8/9).

Node.js Runtime — bcrypt نسخه‌ی native به build tooling نیاز دارد.

PostgreSQL منبع حقیقت؛ Prisma برای Access و Migration.

HTTPS برای Production و PWA الزامی است.

Secrets فقط در Server Environment؛ Client Bundle بدون Secret.

Monolith لایه‌ای (Next.js App Router) به‌صورت یک Application مستقر می‌شود (Section 3).

12.2 Current Deployment State

هیچ کانفیگ deploy ای (Dockerfile / vercel.json / CI) در بررسی‌های فعلی تأیید نشده است.

Target Hosting: Deferred / Not Decided

انتخاب Hosting بر اساس: Node.js Runtime، PostgreSQL، HTTPS، Env Vars، Prisma Migration، Single/Multi Instance، Rate Limiting و PWA Requirements — در صورت اهمیت با ADR مستقل.

12.3 Environment Variables

DATABASE_URL        (Secret)

JWT_SECRET          (Secret)

AIXAI_API_KEY       (Secret)

AIXAI_BASE_URL      (پیشفرض https://1xai.ir/v1 — از کد تأییدشده)

AIXAI_MODEL         (پیشفرض deepseek-chat — از کد تأییدشده)

AI_MAX_ATTEMPTS     (اختیاری — از کد)

AI_TIMEOUT_MS       (اختیاری — از کد)

Secrets هرگز در Client Bundle یا Responseهای عمومی قرار نمی‌گیرند.

12.4 Database Migration

Prisma Migration به‌صورت کنترلشده در Deployment انجام می‌شود.

Automatic Migration در CI/CD تا زمان انتخاب Platform تصمیم قطعی V1 نیست.

12.5 Deployment Risks

In-memory Rate Limiting در Multi-instance

Native bcrypt و Build Environment

Prisma Migration Strategy

Service Worker / HTTPS

Environment Secret Configuration

نبود CI/CD

نبود Monitoring متمرکز

12.6 Future Deployment (Deferred)

Multi-instance • Distributed Rate Limiting (Redis) • Centralized Logging/Monitoring • CI/CD کامل • Automated Migration Pipeline • Dockerization • Storage Provider

هیچ‌کدام بدون نیاز واقعی و Decision مستقل وارد Architecture نمی‌شوند.

12.7 Status

LOCKED — به‌عنوان مدل و فرضیات Deployment V1 (Target انتخاب‌نشده عمداً Deferred ثبت شده).

13. Future Roadmap

فهرست کاندیداها — نه تعهد.

هر مورد چرخه‌ی زیر را طی می‌کند:

Product Need → Architecture Impact → Security/Data Impact → Decision → ADR (در صورت اهمیت) → Implementation

13.1 Product

Habit System (Deferred در 5/6)

Notifications / Task Reminders (Deferred)

External Calendar Integration

Analytics Dashboard (روی TaskEvent + summaryها)

PRO Subscription / Payment (شروع با User.plan؛ Entitlement/Quota فقط با نیاز واقعی)

User Timezone Change (Deferred در 6)

Advanced Planning Features

13.2 AI

AI Coach / Assistant (History-aware — مبتنی بر TaskEvent)

Planned vs Actual با spentMinutes

Multi-factor Planning (deadline، دسترس‌پذیری، انرژی، تاریخچه)

Personalized Recommendations

AI Result History / textHash / stale strategy (Section 6)

AI Usage Quota

13.3 Platform

Native Android/iOS (V1 = Web + PWA — Section 4)

تعمیم Offline Queue به General Sync (سایر mutationها، Conflict Resolution، Background Sync) — Queue فعلی فقط Create Task است (Section 9)

Push Notifications

Advanced Offline

13.4 Engineering & Quality

Test Framework + اسکریپت‌های test / typecheck / db:*

Centralized Logging / Observability / Error Monitoring

Distributed Rate Limiting

Next.js Major Upgrade (13.5.6 فعلاً پین است — Section 4)

جایگزینی moment-jalaali با Intl/Persian Calendar (Section 4)

Error Message i18n بر اساس code (Section 9)

Email Provider: Email Verification / Password Reset (Section 8)

Refresh Token / Revocation هنگام Payment/PRO (Section 8)

TimeEntry مستقل وقتی session/timer لازم شد (Section 5/6)

Server Actions در صورت Use Case مشخص (ADR — Section 4)

Object Storage برای Avatar (خروج از DB/Base64 — ADR Candidate، Section 8)

13.5 Roadmap Principle

Roadmap به‌تنهایی مجوز Implementation نیست.

هیچ موردی به‌صرف وجود نامش به V1 اضافه نمی‌شود.

13.6 Status

LOCKED — به‌عنوان فهرست کاندیداها (نه تعهد).

لایه | مسئولیت | نماینده در کد

Presentation | نمایش، interaction و state سمت کلاینت | components/, contexts/, RSCs

API | HTTP boundary، authentication، validation، authorization و response | app/api/*/route.ts

Business / Domain | قوانین دامنه، AI orchestration، scheduling، time tracking و domain utilities | app/lib/

Database | منبع حقیقت و persistence | PostgreSQL, prisma/schema.prisma, Prisma client

External Services | سرویس‌های خارج از application | AI provider و سرویس‌های آینده

Technology | Version / Status | Role

Next.js | 13.5.6 | App Router، React Server Components، Route Handlers

React | ^18 | UI

TypeScript | ^5 | Type-safe development

CSS اختصاصی | Current | Design System، Design Tokens و UI Primitives

PostCSS | ^8 | CSS processing

Autoprefixer | ^10 | Vendor prefixing

Tailwind CSS | Not used | پروژه از Tailwind استفاده نمی‌کند

Technology | Version / Status | Role

Next.js Route Handlers | 13.5.6 | Client → Server API boundary

Server Components | Current | Server-side data access / rendering

Server Actions | Not used | فعلاً بخشی از معماری نیست

Technology | Version / Status | Role

PostgreSQL | Current | Source of Truth

Prisma | ^5.22.0 | ORM / Database access

@prisma/client | ^5.22.0 | Database client

Library | Version | Role

bcrypt | ^6.0.0 | Password hashing

jsonwebtoken | ^9.0.3 | JWT authentication

zod | ^4.5.4 | Validation / schema parsing

@hookform/resolvers | ^5.9.1 | Form validation integration

react-hook-form | ^7.87.0 | Form management

moment-jalaali | ^0.10.5 | Jalali calendar/date handling

framer-motion | ^11.18.2 | UI animation

lucide-react | ^1.39.0 | Icons

react-toastify | ^11.1.0 | Toast notifications

qrcode | ^1.5.4 | QR Code generation

Decision | Final

TaskEvent boundary | زیرمجموعه Tasks

Time Tracking | فعال در V1

TimeEntry Entity | فعلاً ایجاد نشود

Actual duration | spentMinutes روی Task

Completion | شامل ثبت actual duration

Rebalance ownership | Daily Planning

Rebalance strategy | Lazy / On-Demand

Stale detection ownership | Daily Planning

Stale mechanism | در Section 6

Canonical day representation | در Section 6؛ dayKey جلالی فعلی قرارداد دائمی نیست

TaskEvent types | Extensible؛ EDITED/UPDATED کاندید → Section 6

Rollover ownership | Daily Planning (تشخیص) + Tasks (mutation) + TaskEvent (ثبت)

Task Edit API | شکاف پیاده‌سازی ثبت شد؛ route در کد فعلی موجود نیست

Summary / history | بخشی از Daily Planning؛ supporting component، نه Domain جدا

AI gating | فعلاً User.plan

Entitlement / Quota | Deferred

Habits | Deferred

Notifications | Deferred

Model | Current Fields / State | Notes

User | id, username, email @unique, password, firstName?, lastName?, birthDate?, phone?, image? | فاقد timezone, locale, calendar, plan

Task | text, category?, priority, score?, reason?, estimatedTime?, allocatedMinutes?, spentMinutes?, scheduledDate, dayKey?, previousScheduledDate?, status, completedAt?, completedOn?, createdAt, updatedAt, userId | dayKey فعلی جلالی است

DailyPlan | dayKey, availableMinutes, userId, createdAt | @@unique([userId, dayKey])؛ فاقد stale/version mechanism

TaskEvent | ندارد | در V1 باید اضافه شود

DecisionFinal | 

AI Analysis storage | Nullable columns on Task

TaskAnalysis Entity | ❌ Deferred / Not created

Canonical dayKey | Gregorian local YYYY-MM-DD

completedOn | Gregorian local YYYY-MM-DD

Day calculation | Server-side using User.timezone

Calendar | Presentation concern

scheduledDate | Absolute DateTime representing local midnight

Rebalance stale detection | Version-based

planVersion | Increment on effective planning mutation

rebalancedVersion | Last successfully processed plan version

planVersion atomicity | Same transaction + atomic increment

DailyPlan absent row | = stale؛ سمانتیک ایجاد مطابق ۶.۳.۳

Rebalance | Lazy / On-Demand

priority | Nullable

category ownership | فراداده‌ی کاربر؛ AI فقط در صورت خالی بودن پیشنهاد/مقداردهی

AI invalidation on content edit | Yes — فقط score/priority/estimatedTime/reason

category invalidation on edit | ❌ هرگز پاک نمی‌شود

allocatedMinutes on content edit | Preserved تا Rebalance بعدی

Planning-only mutation effect | فقط planVersion++ + رویداد مناسب؛ AI fields untouched

Edit event | EDITED (فقط Content Mutation)

TaskEvent | Active in V1

TaskEvent history | Append-only, Task-scoped

TaskEvent delete behavior | Cascade with Task

Summary storage | Computed-on-read

DailyPlan aggregate columns | ❌ Not added

Time Tracking | Active

TimeEntry | ❌ Not created in V1

spentMinutes | Stored on Task

Habit | ❌ Deferred

Notification | ❌ Deferred

User default timezone | Asia/Tehran

User default locale | fa

User default calendar | JALALI

User default plan | FREE

Timezone change | ❌ Not supported in V1 UI

Available minutes ownership | Section 3 / ADR-02 (implementation plan)

فایل | مسئولیت

analyzeTask.ts | Orchestrator: فراخوانی Provider، timeout، retry/backoff، fallback به mock

aiSchema.ts | قرارداد خروجی با zod — تنها مرز معتبر

repair.ts (parseAiJson) | نرمال‌سازی خروجی raw قبل از اعتبارسنجی نهایی

mock.ts | Fallback قطعی و قابل تست

 | V1 (فعلی) | آینده

Input | متن Task (text) | + deadline، دسترس‌پذیری، تاریخچه رفتار (TaskEvent)، context

Process | یک-shot تحلیل عنوان | تحلیل چندعاملی + پیشنهاد

Output | { score, priority, estimatedMinutes, reason, category } | + برنامه‌ی پیشنهادی، هشدار عقب‌افتادگی

Operation | Key | Limit

Register | register:ip | 5 / hour

Login by IP | login:ip | 10 / 15 min

Login by Email | login:email | 5 / 15 min

Category | HTTP Status | Error Code

Validation Error | 400 | VALIDATION_ERROR

Authentication Failure | 401 | UNAUTHORIZED

Resource Not Found / Ownership Failure | 404 | NOT_FOUND

Conflict | 409 | CONFLICT

Rate Limit | 429 | RATE_LIMITED

Unexpected Internal Error | 500 | INTERNAL

Decision | V1

Standard API Envelope | LOCKED

ADR-04 Compatibility | LOCKED

ok field | Required

Machine-readable Error Code | Required

Persian Error Messages | Yes

Error i18n | Deferred

Validation | Zod at HTTP Boundary

Authentication Error | 401

Ownership / Not Found | 404

Conflict | 409

Rate Limit | 429

Unexpected Error | 500

Prisma Error Mapping | Required for known errors

AI Failure | Mock Degradation

Client Loading/Error/Retry | Required

Toast | Supported

Offline Indicator | V1

Offline Mutation Queue | No

Automatic Offline Sync | No

console.error Logging | V1

Centralized Observability | Deferred

Business Logic in Route Handler | No

مرز / لایه | مسئولیت معماری | قواعد الزامی

HTTP Boundary (app/api) | Route Handlerها — تنها مرز Client → Server | Thin (ADR-02)؛ الگوی Parse→Authenticate→Validate→Authorize→Service→Response؛ بدون Business Logic

Server-side Business / Infrastructure (app/lib) | منطق دامنه، دسترسی DB، یکپارچه‌سازی | فقط سمت سرور؛ Client به آن دسترسی ندارد

AI Boundary (app/lib/ai) | تنها جایی که AI Provider شناخته می‌شود | Provider-swappable؛ خروجی با zod (Section 7)

Planner Boundary (app/lib/planner) | Rebalance (pure/idempotent) و Summary | Lazy/On-Demand (ADR-03)؛ مستقل از HTTP/UI

Validation Boundary (app/schema) | Zod Schemaها | اعتبارسنجی در مرز HTTP (Section 9)

UI Boundary (app/components) | Client Components | بدون Prisma/Secret/Server-only Infrastructure

Persistence (prisma) | Schema + Migration — منبع حقیقت داده | مدل داده طبق Section 6

Static / PWA (public) | دارایی‌های استاتیک + PWA (sw.js، manifest) | API/RSC هرگز توسط SW کش نشوند (Section 9)