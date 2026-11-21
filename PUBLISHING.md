# Как выложить расширение на GitHub

Инструкция для первого раза. Рекомендуемый способ — **GitHub Desktop** (графический клиент, не нужно учить команды Git). В конце есть вариант через Git CLI.

## 1. Создай аккаунт GitHub

1. Открой https://github.com/signup
2. Зарегистрируйся и подтверди e-mail.
3. Придумай имя пользователя — оно попадёт в адрес репозитория:
   `https://github.com/<твой-логин>/hydraroute-neo-quick-add`

## 2. Установи GitHub Desktop

1. Скачай: https://desktop.github.com/
2. Установи и запусти.
3. Войди в свой аккаунт GitHub: **File → Options → Accounts → Sign in**.

## 3. Добавь папку расширения в GitHub Desktop

1. В GitHub Desktop: **File → Add local repository…**
2. Укажи папку:

```text
E:\Opencode\HydraRouteNeo-Extension
```

3. Если GitHub Desktop скажет, что это не Git-репозиторий, нажми ссылку **«create a repository»**.
4. Заполни:
   - **Name:** `hydraroute-neo-quick-add`;
   - **Description:**  
     `Chrome/Edge extension: one-click add of the current site to HydraRoute Neo rules, with optional RKN check via 2whois.`
   - **Local path:** оставь `E:\Opencode\HydraRouteNeo-Extension`;
   - **Initialize this repository with a README:** не ставь галочку — README уже есть;
   - **Git ignore:** не нужен — `.gitignore` уже есть;
   - **License:** не нужен — `LICENSE` уже есть.
5. Нажми **Create repository**.

## 4. Сделай первый коммит

1. В левом меню GitHub Desktop появятся изменённые файлы.
2. Внизу в поле **Summary** напиши:

```text
Initial commit: HydraRoute Neo Quick Add 0.9.5
```

3. Нажми **Commit to main**.

## 5. Опубликуй репозиторий

1. В GitHub Desktop: **Repository → Publish repository…**
2. **Name:** можно оставить `hydraroute-neo-quick-add`.
3. **Description:** вставь описание выше.
4. Если хочешь, чтобы код был виден всем — **сними галочку Keep this code private**.
5. Нажми **Publish repository**.

После этого репозиторий появится на GitHub. Кнопка **View on GitHub** откроет его в браузере.

## 6. Оформи репозиторий

На странице репозитория нажми **About** (справа) и добавь:

- **Description:**  
  `One-click add of the current site to HydraRoute Neo rules, with optional RKN check via 2whois.`
- **Topics:**  
  `hydraroute`, `keenetic`, `chrome-extension`, `edge-extension`, `manifest-v3`, `rkn`, `2whois`
- **License:** GitHub сам определит MIT из `LICENSE`.

README уже лежит в репозитории и отобразится на главной странице.

## 7. Сделай релиз с готовым zip

Расширение удобно ставить из архива, а не собирать вручную.

1. Собери архив:

```powershell
powershell -ExecutionPolicy Bypass -File E:\Opencode\HydraRouteNeo-Extension\build.ps1
```

Скрипт создаст:

```text
E:\Opencode\HydraRouteNeo-Extension\dist\HydraRouteNeo-Extension-<версия>.zip
```

2. На GitHub открой репозиторий → **Releases** → **Draft a new release**.
3. Заполни:
   - **Choose a tag:** `v0.9.5` (создать новый тег);
   - **Target:** `main`;
   - **Release title:** `v0.9.5`;
   - **Description:** кратко, что умеет расширение.
4. Прикрепи файл из `dist\...zip` в разделе **Attach binaries**.
5. Нажми **Publish release**.

В релизе появится кнопка скачивания zip. Пользователь скачивает, распаковывает и загружает папку через `chrome://extensions` → «Загрузить распакованное расширение».

## 8. Как обновлять репозиторий

После изменений:

1. Измени файлы.
2. Подними версию в `manifest.json` (например, `0.9.5` → `0.9.6`).
3. В GitHub Desktop:
   - проверь изменения;
   - напиши Summary, например `Fix: close background RKN tab`;
   - **Commit to main**;
   - **Push origin**.
4. Собери новый zip:

```powershell
powershell -ExecutionPolicy Bypass -File E:\Opencode\HydraRouteNeo-Extension\build.ps1
```

5. Создай новый Release с тегом `v0.9.6` и новым zip.

## Вариант через Git CLI

Если Git уже установлен или хочешь освоить команды:

1. Установи Git: https://git-scm.com/download/win
2. Настрой имя и e-mail:

```powershell
git config --global user.name "Твоё Имя"
git config --global user.email "твой@email"
```

3. В папке расширения:

```powershell
cd E:\Opencode\HydraRouteNeo-Extension
git init
git add .
git commit -m "Initial commit: HydraRoute Neo Quick Add 0.9.5"
git branch -M main
```

4. Создай **пустой** репозиторий на GitHub (без README, без .gitignore, без лицензии).
5. Подключи его и отправь код:

```powershell
git remote add origin https://github.com/<твой-логин>/hydraroute-neo-quick-add.git
git push -u origin main
```

При первом push Git попросит авторизоваться — откроется браузер, войди в GitHub.

## Частые проблемы

**«This directory does not appear to be a Git repository»**  
Нажми в GitHub Desktop ссылку «create a repository» и создай репозиторий в этой папке.

**GitHub Desktop не видит `dist` с zip**  
Так и задумано: `dist/` добавлен в `.gitignore`, чтобы не хранить бинарные архивы в истории Git. Zip загружается в **Releases**, а не в обычный коммит.

**Случайно закоммитил пароль или IP роутера**  
Удали файл/строку, сделай новый коммит. Если секрет уже в истории — смени пароль и при необходимости очисти историю (новичку проще создать новый репозиторий без секрета).

**Хочу приватный репозиторий**  
В GitHub Desktop при публикации оставь галочку **Keep this code private**. Тогда код будет виден только тебе; Releases тоже будут приватными.

**Хочу, чтобы расширение было в Chrome Web Store**  
Это отдельный процесс: регистрация разработчика, оплата, проверка, политика конфиденциальности. Для личного использования и GitHub-релиза это не нужно.

## Что уже подготовлено

- `README.md` — описание расширения;
- `LICENSE` — MIT;
- `.gitignore` — исключает `dist/`, логи и кэш Python;
- `build.ps1` — сборка zip с версией из `manifest.json`;
- `dev/` — mock-сервер и тесты (можно оставить в репозитории, это плюс для доверия и разработки).
