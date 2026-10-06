@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Carla Wiring
echo ================ Carla Wiring ================
echo.

if not exist package.json (
  echo [!] Ce fichier n'est pas dans le bon dossier.
  echo     Il doit etre dans le dossier qui contient package.json et src-tauri.
  echo     Dossier actuel : %cd%
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js n'est pas installe, ou il faut fermer puis rouvrir cette fenetre apres l'avoir installe.
  echo     Installez la version LTS : https://nodejs.org
  echo     Puis double-cliquez de nouveau sur LANCER.bat
  pause
  exit /b 1
)

where cargo >nul 2>nul
if errorlevel 1 (
  echo [!] Rust n'est pas installe, ou il faut fermer puis rouvrir cette fenetre apres l'avoir installe.
  echo     Allez sur https://rustup.rs , telechargez rustup-init.exe, lancez-le et appuyez sur Entree
  echo     pour accepter l'installation par defaut. Puis double-cliquez de nouveau sur LANCER.bat
  pause
  exit /b 1
)

if not exist node_modules (
  echo Premiere fois : installation des composants. Internet est necessaire, cela prend quelques minutes.
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo [!] L'installation a echoue. Copiez les lignes affichees ci-dessus et envoyez-les.
    pause
    exit /b 1
  )
)

echo.
echo Lancement de l'application.
echo La premiere fois, la preparation dure plusieurs minutes : ne fermez pas cette fenetre.
echo Une fenetre "Carla Wiring" s'ouvrira toute seule. Gardez CETTE fenetre ouverte tant que vous utilisez l'application.
echo.
call npm run tauri dev

echo.
echo L'application s'est arretee. S'il y a un message d'erreur ci-dessus, copiez-le et envoyez-le.
pause
