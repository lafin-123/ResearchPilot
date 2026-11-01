param(
  [Parameter(Mandatory = $true)][string]$Presentation,
  [Parameter(Mandatory = $true)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$inputPath = [System.IO.Path]::GetFullPath($Presentation)
$outputPath = [System.IO.Path]::GetFullPath($OutputDirectory)
if (-not (Test-Path -LiteralPath $inputPath -PathType Leaf)) { throw 'Presentation not found' }
if (-not (Test-Path -LiteralPath $outputPath -PathType Container)) { throw 'Output directory must already exist' }
$powerpoint = $null
$deck = $null
$existingPresentations = 0
$oldSecurity = $null
$oldAlerts = $null
try {
  $powerpoint = New-Object -ComObject PowerPoint.Application
  $existingPresentations = $powerpoint.Presentations.Count
  $oldSecurity = $powerpoint.AutomationSecurity
  $oldAlerts = $powerpoint.DisplayAlerts
  $powerpoint.AutomationSecurity = 3
  $powerpoint.DisplayAlerts = 1
  $deck = $powerpoint.Presentations.Open($inputPath, -1, 0, 0)
  $deck.Export($outputPath, 'PNG', 1600, 960)
  [Console]::WriteLine('PowerPoint opened and rendered {0} slide(s).', $deck.Slides.Count)
} finally {
  if ($null -ne $deck) { $deck.Close(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($deck) }
  if ($null -ne $powerpoint) { if ($existingPresentations -eq 0) { $powerpoint.Quit() }; [void][Runtime.InteropServices.Marshal]::ReleaseComObject($powerpoint) }
}
