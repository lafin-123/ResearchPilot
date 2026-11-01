$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

function Find-BridgeConfig {
  $dir = (Get-Location).Path
  while ($true) {
    $candidate = Join-Path $dir ".research\bridge.json"
    if (Test-Path -LiteralPath $candidate) {
      return (Get-Content -LiteralPath $candidate -Raw | ConvertFrom-Json)
    }
    $parent = Split-Path -Path $dir -Parent
    if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $dir) { break }
    $dir = $parent
  }
  throw "未找到 .research\bridge.json。请在 ResearchPilot 项目目录内运行此命令，并保持应用开启。"
}

function Invoke-Bridge {
  param(
    [Parameter(Mandatory = $true)][string]$Method,
    [hashtable]$Params = @{}
  )
  $script:config = if ($script:config) { $script:config } else { Find-BridgeConfig }
  $body = @{
    method    = $Method
    params    = $Params
    projectId = $script:config.projectId
  } | ConvertTo-Json -Depth 40 -Compress
  $headers = @{ Authorization = "Bearer $($script:config.token)" }
  $uri = "http://127.0.0.1:$($script:config.port)/rpc"
  try {
    $response = Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -ContentType "application/json; charset=utf-8" -Body $body -TimeoutSec 86400
  } catch {
    throw "无法连接 ResearchPilot Bridge：$($_.Exception.Message)"
  }
  if (-not $response.ok) { throw $response.error }
  return $response.result
}

function Parse-Options {
  param([string[]]$Tokens)
  $options = @{}
  $i = 0
  while ($i -lt $Tokens.Count) {
    $token = $Tokens[$i]
    if ($token -like "--*") {
      $rawKey = $token.Substring(2)
      $key = switch ($rawKey) {
        "code-file" { "codeFile" }
        "spec-file" { "specFile" }
        "ssh-host-id" { "sshHostId" }
        "experiment-id" { "experimentId" }
        "document-id" { "documentId" }
        "run-id" { "runId" }
        default { $rawKey }
      }
      if ($i + 1 -lt $Tokens.Count -and -not $Tokens[$i + 1].StartsWith("--")) {
        $options[$key] = $Tokens[$i + 1]
        $i += 2
      } else {
        $options[$key] = $true
        $i += 1
      }
    } else {
      $i += 1
    }
  }
  if ($options.ContainsKey("timeout")) { $options["timeout"] = [int]$options["timeout"] }
  if ($options.ContainsKey("rows")) { $options["rows"] = [int]$options["rows"] }
  if ($options.ContainsKey("port")) { $options["port"] = [int]$options["port"] }
  if ($options.ContainsKey("remote")) { $options["remote"] = [bool]$options["remote"] }
  return $options
}

function Print-Result {
  param($Value)
  if ($null -eq $Value) { Write-Output "null"; return }
  if ($Value -is [string]) { Write-Output $Value; return }
  $Value | ConvertTo-Json -Depth 40
}

$script:config = $null
$argv = @($args)
if ($argv.Count -eq 0) {
  Write-Output "ResearchPilot Bridge CLI"
  Write-Output "用法: research <status|docs|refs|exps|figs|ssh|evidence> [子命令] [--选项 值]"
  exit 0
}

$group = $argv[0]
$sub = if ($argv.Count -gt 1 -and -not $argv[1].StartsWith("--")) { $argv[1] } else { "" }
$optionStart = if ($sub) { 2 } else { 1 }
$optionTokens = if ($optionStart -lt $argv.Count) { $argv[$optionStart..($argv.Count - 1)] } else { @() }
$options = Parse-Options -Tokens $optionTokens

try {
  switch ($group) {
    "status" {
      Print-Result (Invoke-Bridge -Method "status")
    }
    "help" {
      Write-Output "docs: list | read --id | create --title --format | write --id --file | compile --id"
      Write-Output "refs: list [--query] | search --query | add --doi | export"
      Write-Output "exps: list | create --name --code-file | run --id [--timeout] | status --id | logs --id"
      Write-Output "figs: list | create --spec-file <project.json> [--name] | get --id | update --id --spec-file | export --id --format pptx"
      Write-Output "figs legacy: render --name --code-file [--experiment-id] (Python, approval required; raster is not editable)"
      Write-Output "ssh: list | exec --host --command"
      Write-Output "evidence: report"
    }
    "docs" {
      switch ($sub) {
        "list" { Print-Result (Invoke-Bridge -Method "docs.list") }
        "read" { Print-Result (Invoke-Bridge -Method "docs.read" -Params $options) }
        "create" {
          if (-not $options["format"]) { $options["format"] = "docx" }
          Print-Result (Invoke-Bridge -Method "docs.create" -Params $options)
        }
        "write" { Print-Result (Invoke-Bridge -Method "docs.write" -Params $options) }
        "compile" { Print-Result (Invoke-Bridge -Method "docs.compile" -Params $options) }
        default { throw "未知 docs 子命令：$sub" }
      }
    }
    "refs" {
      switch ($sub) {
        "list" { Print-Result (Invoke-Bridge -Method "refs.list" -Params $options) }
        "search" { Print-Result (Invoke-Bridge -Method "refs.search" -Params $options) }
        "add" { Print-Result (Invoke-Bridge -Method "refs.add" -Params $options) }
        "export" { Print-Result (Invoke-Bridge -Method "refs.export") }
        default { throw "未知 refs 子命令：$sub" }
      }
    }
    "exps" {
      switch ($sub) {
        "list" { Print-Result (Invoke-Bridge -Method "exps.list") }
        "create" { Print-Result (Invoke-Bridge -Method "exps.create" -Params $options) }
        "run" { Print-Result (Invoke-Bridge -Method "exps.run" -Params $options) }
        "status" { Print-Result (Invoke-Bridge -Method "exps.status" -Params $options) }
        "logs" { Print-Result (Invoke-Bridge -Method "exps.logs" -Params $options) }
        default { throw "未知 exps 子命令：$sub" }
      }
    }
    "figs" {
      switch ($sub) {
        "list" { Print-Result (Invoke-Bridge -Method "figs.list") }
        "create" { Print-Result (Invoke-Bridge -Method "figs.create" -Params $options) }
        "get" { Print-Result (Invoke-Bridge -Method "figs.get" -Params $options) }
        "update" { Print-Result (Invoke-Bridge -Method "figs.update" -Params $options) }
        "export" { Print-Result (Invoke-Bridge -Method "figs.export" -Params $options) }
        "render" { Print-Result (Invoke-Bridge -Method "figs.render" -Params $options) }
        default { throw "未知 figs 子命令：$sub" }
      }
    }
    "ssh" {
      switch ($sub) {
        "list" { Print-Result (Invoke-Bridge -Method "ssh.list") }
        "exec" { Print-Result (Invoke-Bridge -Method "ssh.exec" -Params $options) }
        default { throw "未知 ssh 子命令：$sub" }
      }
    }
    "evidence" {
      switch ($sub) {
        "report" { Print-Result (Invoke-Bridge -Method "evidence.report") }
        default { throw "未知 evidence 子命令：$sub" }
      }
    }
    default { throw "未知命令：$group" }
  }
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
