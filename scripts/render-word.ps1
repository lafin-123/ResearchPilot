param([Parameter(Mandatory=$true)][string]$Document, [Parameter(Mandatory=$true)][string]$Pdf)
$ErrorActionPreference='Stop'
$inputPath=[IO.Path]::GetFullPath($Document)
$outputPath=[IO.Path]::GetFullPath($Pdf)
if (-not(Test-Path -LiteralPath $inputPath -PathType Leaf)) { throw 'Document missing' }
if (-not(Test-Path -LiteralPath ([IO.Path]::GetDirectoryName($outputPath)) -PathType Container)) { throw 'Output directory must exist' }
$word=$null; $doc=$null; $existing=0; $oldAlerts=$null; $oldSecurity=$null
try {
 $word=New-Object -ComObject Word.Application
 $existing=$word.Documents.Count
 $oldAlerts=$word.DisplayAlerts; $oldSecurity=$word.AutomationSecurity
 $word.DisplayAlerts=0; $word.AutomationSecurity=3
 $doc=$word.Documents.Open($inputPath,$false,$true,$false)
 $doc.ExportAsFixedFormat($outputPath,17)
 [Console]::WriteLine(('Word opened and exported {0} pages, {1} inline images.' -f $doc.ComputeStatistics(2), $doc.InlineShapes.Count))
} finally {
 if($null -ne $doc){$doc.Close(0);[void][Runtime.InteropServices.Marshal]::ReleaseComObject($doc)}
 if($null -ne $word){if($null -ne $oldAlerts){$word.DisplayAlerts=$oldAlerts};if($null -ne $oldSecurity){$word.AutomationSecurity=$oldSecurity};if($existing -eq 0){$word.Quit()};[void][Runtime.InteropServices.Marshal]::ReleaseComObject($word)}
}
