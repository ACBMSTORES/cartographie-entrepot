# Runs the full warehouse-map refresh pipeline: rebuild data from the latest
# SAP BO export (if any), then commit + push if something actually changed.
# Registered as an hourly Windows Scheduled Task ("CartographieEntrepotUpdate")
# so it runs independently of Claude Code being open.

$repo = "C:\Users\achawki\OneDrive - B&M FRANCE SAS\Documents\GitHub\cartographie-entrepot"
$log = Join-Path $repo "scripts\update.log"

Set-Location $repo
$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Add-Content -Path $log -Value "---- $timestamp ----"

$output = & python scripts\build_data.py 2>&1
$exitCode = $LASTEXITCODE
Add-Content -Path $log -Value ($output | Out-String)

if ($exitCode -eq 0) {
    $gitOut = git add emplacements.txt meta.json 2>&1
    Add-Content -Path $log -Value ($gitOut | Out-String)
    $gitOut = git commit -m "Mise a jour automatique des donnees" 2>&1
    Add-Content -Path $log -Value ($gitOut | Out-String)
    $gitOut = git push origin main 2>&1
    Add-Content -Path $log -Value ($gitOut | Out-String)
    Add-Content -Path $log -Value "Resultat: deploye avec succes."
} else {
    Add-Content -Path $log -Value "Resultat: rien a faire (pas de nouvel export ou partage inaccessible)."
}
