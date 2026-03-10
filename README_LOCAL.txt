Guardians of Galaxy v2.0
========================
Web Accessibility / Spelling / Link Inspector

HOW TO USE (Windows)
--------------------

STEP 1: Install Node.js (one time only)
  - Go to: https://nodejs.org
  - Click the green LTS button
  - Install the downloaded file

STEP 2: Run SETUP.bat (one time only)
  - Double-click SETUP.bat
  - Wait for installation to complete (5-10 min)
  - Internet connection required

STEP 3: Run START.bat (every time)
  - Double-click START.bat
  - Browser opens automatically at http://localhost:3000

FOR MINWON SCAN:
  - Go to: http://localhost:3000/minwon.html
  - Click "Batch Scan" tab
  - Click step button (1st / 2nd / 3rd)

IMPORTANT:
  - Do NOT close the black window while scanning
  - Scanning all 1963+ pages takes several hours
  - Server runs only on your local PC (gov.kr access required)

FOLDER STRUCTURE:
  SETUP.bat          <- Run ONCE for installation
  START.bat          <- Run every time to start
  server.cjs         <- Server program (do not edit)
  package.json       <- Package list (do not edit)
  data/
    minwon-list.xlsx <- Minwon list (8461 items)
  public/
    index.html       <- Main page
    minwon.html      <- Minwon scan page
