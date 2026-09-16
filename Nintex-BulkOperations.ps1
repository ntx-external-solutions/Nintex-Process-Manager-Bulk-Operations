# Nintex Process Manager Bulk Operations Script
# Supports: Archive, Restore, Update Location, Update Ownership, and Delete operations
#
# The version lives in $script:ScriptVersion below and is printed at startup.
# It is defined once so the header, the banner and the README cannot drift apart
# the way they did through 1.1, 4.0 and "DEPRECATED".

#Requires -Version 5.1

<#
.SYNOPSIS
    Bulk archive, restore, relocate, re-own and delete content in Nintex Process
    Manager.

.DESCRIPTION
    Runs two ways.

    Interactively, with no parameters, it prints a menu and prompts for
    everything, which is how an operator uses it.

    Non-interactively, with -Mode, it skips the menu entirely and runs that one
    mode from the parameters given. This is what makes the script scriptable and
    testable: the menu used to run at load, so the file could not even be
    dot-sourced without executing the whole program, and a redirected stdin sent
    it into an infinite invalid-selection loop.

.PARAMETER Mode
    1 Archive, 2 Restore, 3 Update Location, 4 Update Ownership, 5 Delete.
    Supplying it skips the menu and runs that mode once.

.PARAMETER Source
    Where the target set comes from: CSV, Group, Archived, or ArchivedDocuments.

.PARAMETER ObjectType
    Process, Document, or Both, for the modes that act on either.

.PARAMETER WhatIf
    Preview. Nothing is changed.

.PARAMETER Force
    Answer the confirmation prompts affirmatively and run unattended. It does NOT
    wave through a reconciliation mismatch or a failed verification in Mode 5:
    those still stop the run, because they mean the plan does not match the
    tenant. It does not imply -AllowUnheldTargets either.

.PARAMETER AllowUnheldTargets
    Mode 5 only, and dangerous. Delete a target even though it could not be
    restored out of the archive.

    The Hold phase exists because archiving hides Input and Output rows: a
    reference held against an archived target is invisible until the target is
    active. A target that never came out of the archive was never checked, so
    deleting it can leave a dangling reference on a process that survives.

    Without this switch such a target is excluded from the run and reported as
    skipped, and the rest of the batch proceeds. -Force does not imply it.

.EXAMPLE
    .\Nintex-BulkOperations.ps1
    The menu, as before.

.EXAMPLE
    .\Nintex-BulkOperations.ps1 -Mode 5 -Source Archived -WhatIf
    Dry-run a delete over the whole archive, no prompts.

.EXAMPLE
    .\Nintex-BulkOperations.ps1 -Mode 5 -Source CSV -CsvPath .\targets.csv -Force
    Delete the processes named in a CSV, unattended.

.EXAMPLE
    . .\Nintex-BulkOperations.ps1
    Dot-source for tests. Loads the functions and runs nothing.
#>
param(
    [ValidateSet('1','2','3','4','5')]
    [string]$Mode,

    [ValidateSet('CSV','Group','Archived','ArchivedDocuments')]
    [string]$Source,

    [string]$CsvPath,

    [int]$GroupId = -1,

    [ValidateSet('Process','Document','Both')]
    [string]$ObjectType,

    [int]$RestoreGroupId = -1,

    [string]$ConfigPath = 'config.txt',

    [switch]$WhatIf,
    [switch]$Force,
    [switch]$ApprovalsEnabled,
    [switch]$ThoroughScan,
    [switch]$IncludeSubgroups,
    [switch]$AllowUnheldTargets
)

$script:ScriptVersion = '4.6'

# ----------------------------------------------------------------------------
# Dependency engine. Mode 5 delegates all dependency discovery, reference
# removal and process deletion to this file; see API_ARCHITECTURE.md for why
# that logic cannot live inline any more.
# ----------------------------------------------------------------------------
$script:DependencyEnginePath = Join-Path $PSScriptRoot 'NintexProcessDependencies.ps1'
if (-not (Test-Path $script:DependencyEnginePath)) {
    Write-Host "Required file not found: $script:DependencyEnginePath" -ForegroundColor Red
    Write-Host "NintexProcessDependencies.ps1 must sit next to this script." -ForegroundColor Red
    throw "NintexProcessDependencies.ps1 not found next to Nintex-BulkOperations.ps1"
}
. $script:DependencyEnginePath

# ============================================================================
# CONFIGURATION AND AUTHENTICATION
# ============================================================================

function Read-ConfigFile {
    param([string]$ConfigPath = "config.txt")

    if (-not (Test-Path $ConfigPath)) {
        Write-Host "Configuration file not found: $ConfigPath" -ForegroundColor Red
        Write-Host "Please create a config.txt file based on config.template.txt" -ForegroundColor Yellow
        return $null
    }

    $config = @{}
    Get-Content $ConfigPath | ForEach-Object {
        $line = $_.Trim()
        # Skip empty lines and comments
        if ($line -and -not $line.StartsWith('#')) {
            if ($line -match '^([^=]+)=(.*)$') {
                $key = $matches[1].Trim()
                $value = $matches[2].Trim()
                $config[$key] = $value
            }
        }
    }

    # Validate required fields
    if (-not $config.SiteURL -or -not $config.Username -or -not $config.Password) {
        Write-Host "Configuration file is missing required fields (SiteURL, Username, Password)" -ForegroundColor Red
        return $null
    }

    # Remove trailing slash from SiteURL if present
    $config.SiteURL = $config.SiteURL.TrimEnd('/')

    return $config
}

function Get-AuthToken {
    param(
        [string]$SiteURL,
        [string]$Username,
        [string]$Password
    )

    try {
        $tokenUrl = "$SiteURL/oauth2/token"
        $body = @{
            grant_type = "password"
            username = $Username
            password = $Password
            duration = 60000
        }

        Write-Host "Authenticating to $SiteURL..." -ForegroundColor Cyan
        $response = Invoke-RestMethod -Uri $tokenUrl -Method Post -Body $body -ContentType "application/x-www-form-urlencoded"

        if ($response.access_token) {
            Write-Host "Authentication successful!" -ForegroundColor Green
            return $response.access_token
        } else {
            Write-Host "Authentication failed: No access token received" -ForegroundColor Red
            return $null
        }
    }
    catch {
        Write-Host "Authentication error: $($_.Exception.Message)" -ForegroundColor Red
        return $null
    }
}

# ============================================================================
# API HELPER FUNCTIONS
# ============================================================================

function Invoke-ApiGet {
    param(
        [string]$Url,
        [string]$Token
    )

    try {
        $headers = @{
            "Authorization" = "Bearer $Token"
            "Accept" = "application/json"
            "Content-Type" = "application/json"
            "X-Requested-With" = "XMLHttpRequest"
        }

        $response = Invoke-RestMethod -Uri $Url -Method Get -Headers $headers
        return $response
    }
    catch {
        Write-Host "API GET Error ($Url): $($_.Exception.Message)" -ForegroundColor Red
        return $null
    }
}

function Invoke-ApiPost {
    param(
        [string]$Url,
        [string]$Token,
        [object]$Body = $null
    )

    try {
        $headers = @{
            "Authorization" = "Bearer $Token"
            "Content-Type" = "application/json"
            "Accept" = "application/json"
            "X-Requested-With" = "XMLHttpRequest"
        }

        # Use Invoke-WebRequest to get status code for 204 handling
        if ($Body) {
            $jsonBody = $Body | ConvertTo-Json -Depth 10
            $webResponse = Invoke-WebRequest -Uri $Url -Method Post -Headers $headers -Body $jsonBody -UseBasicParsing
        } else {
            $webResponse = Invoke-WebRequest -Uri $Url -Method Post -Headers $headers -UseBasicParsing
        }

        $statusCode = $webResponse.StatusCode

        # 200-299 are success codes
        if ($statusCode -ge 200 -and $statusCode -lt 300) {
            if ($webResponse.Content) {
                $response = $webResponse.Content | ConvertFrom-Json
                return $response
            } else {
                # 204 No Content or other success with no body - return success indicator
                return @{ success = $true; statusCode = $statusCode }
            }
        } else {
            return $null
        }
    }
    catch {
        Write-Host "API POST Error ($Url): $($_.Exception.Message)" -ForegroundColor Red
        if ($_.Exception.Response) {
            $statusCode = $_.Exception.Response.StatusCode.value__
            Write-Host "  Status Code: $statusCode" -ForegroundColor Red
        }
        return $null
    }
}

function Invoke-ApiPut {
    param(
        [string]$Url,
        [string]$Token,
        [object]$Body
    )

    try {
        $headers = @{
            "Authorization" = "Bearer $Token"
            "Content-Type" = "application/json"
            "Accept" = "application/json"
            "X-Requested-With" = "XMLHttpRequest"
        }

        $jsonBody = $Body | ConvertTo-Json -Depth 20

        # Invoke-RestMethod throws on HTTP errors, so if this succeeds, we got a 2xx response
        # No -StatusCodeVariable needed (not available in PowerShell 5.1)
        $response = Invoke-RestMethod -Uri $Url -Method Put -Headers $headers -Body $jsonBody -ErrorAction Stop

        # Success - assume 200 since no exception was thrown
        return @{ Success = $true; StatusCode = 200; Response = $response }
    }
    catch {
        $errorDetails = $_.Exception.Message
        $statusCode = "Unknown"

        # Try to extract status code from exception
        if ($_.Exception.Response) {
            $statusCode = [int]$_.Exception.Response.StatusCode

            # Try to read response body for more details
            try {
                $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
                $responseBody = $reader.ReadToEnd()
                $reader.Close()
                if ($responseBody) {
                    Write-Host "  Response body: $responseBody" -ForegroundColor Gray
                }
            }
            catch {
                # Couldn't read response body
            }
        }

        Write-Host "API PUT Error ($Url): HTTP $statusCode - $errorDetails" -ForegroundColor Red

        # Return error info instead of null so caller can check status
        return @{ Success = $false; StatusCode = $statusCode; Error = $errorDetails }
    }
}

function Invoke-ApiDelete {
    param(
        [string]$Url,
        [string]$Token,
        [object]$Body = $null
    )

    try {
        $headers = @{
            "Authorization" = "Bearer $Token"
            "Content-Type" = "application/json"
            "Accept" = "application/json"
            "X-Requested-With" = "XMLHttpRequest"
        }

        # Use Invoke-WebRequest to get status code for 204 handling
        if ($Body) {
            $jsonBody = $Body | ConvertTo-Json -Depth 10
            $webResponse = Invoke-WebRequest -Uri $Url -Method Delete -Headers $headers -Body $jsonBody -UseBasicParsing
        } else {
            $webResponse = Invoke-WebRequest -Uri $Url -Method Delete -Headers $headers -UseBasicParsing
        }

        $statusCode = $webResponse.StatusCode

        # 200-299 are success codes
        if ($statusCode -ge 200 -and $statusCode -lt 300) {
            if ($webResponse.Content) {
                $response = $webResponse.Content | ConvertFrom-Json
                return $response
            } else {
                # 204 No Content or other success with no body - return success indicator
                return @{ success = $true; statusCode = $statusCode }
            }
        } else {
            return $null
        }
    }
    catch {
        Write-Host "API DELETE Error ($Url): $($_.Exception.Message)" -ForegroundColor Red
        if ($_.Exception.Response) {
            $statusCode = $_.Exception.Response.StatusCode.value__
            Write-Host "  Status Code: $statusCode" -ForegroundColor Red
        }
        return $null
    }
}

# ============================================================================
# PROCESS AND DOCUMENT RETRIEVAL
# ============================================================================

function Get-ProcessesFromGroup {
    param(
        [string]$SiteURL,
        [string]$Token,
        [int]$GroupID,
        [string]$GroupUniqueId = "",
        [bool]$IncludeSubgroups = $true
    )

    if (-not $GroupUniqueId) {
        Write-Host "  Error: GroupUniqueId is required for efficient group querying" -ForegroundColor Red
        return @()
    }

    $allProcesses = @()

    # Use the breadcrumb/children endpoint for efficient server-side filtering
    # This returns only the direct children of the specified group
    $url = "$SiteURL/bff/navigation/api/v1/breadcrumb/children?type=ProcessGroup&id=$GroupUniqueId"

    $response = Invoke-ApiGet -Url $url -Token $Token

    if ($response -and $response.breadcrumbItems) {
        # Filter for processes (type = "Process")
        $processes = $response.breadcrumbItems | Where-Object { $_.type -eq "Process" }

        if ($processes) {
            # Map breadcrumb format to expected format
            # The breadcrumb 'id' is the process unique ID
            $allProcesses += $processes | ForEach-Object {
                [PSCustomObject]@{
                    processUniqueId = $_.id
                    processName = $_.name
                    groupUniqueId = $_.parentId
                    version = $_.version
                }
            }
        }

        # If including subgroups, recursively get processes from child groups
        if ($IncludeSubgroups) {
            $subgroups = $response.breadcrumbItems | Where-Object { $_.type -eq "ProcessGroup" }

            if ($subgroups) {
                foreach ($subgroup in $subgroups) {
                    $subgroupProcesses = Get-ProcessesFromGroup -SiteURL $SiteURL -Token $Token `
                        -GroupID 0 -GroupUniqueId $subgroup.id -IncludeSubgroups $true
                    $allProcesses += $subgroupProcesses
                }
            }
        }
    }

    return $allProcesses
}

function Get-DocumentsFromGroup {
    param(
        [string]$SiteURL,
        [string]$Token,
        [string]$GroupUniqueId,
        [bool]$IncludeSubgroups = $true
    )

    Write-Host "  Fetching documents..." -ForegroundColor Gray

    if (-not $GroupUniqueId) {
        Write-Host "  Error: GroupUniqueId is required" -ForegroundColor Red
        return @()
    }

    $allDocuments = @()
    $pageSize = 200
    $page = 1

    do {
        $url = "$SiteURL/bff/document/api/v1/documents?Page=$page&PageSize=$pageSize&ListType=All&DocumentType=All&ProcessGroupId=$GroupUniqueId"
        $response = Invoke-ApiGet -Url $url -Token $Token

        if ($response -and $response.items) {
            # If not including subgroups, filter to only documents in the target group
            if ($IncludeSubgroups) {
                $allDocuments += $response.items
            } else {
                $groupDocuments = $response.items | Where-Object {
                    $_.primaryGroupUniqueId -eq $GroupUniqueId
                }
                if ($groupDocuments) {
                    $allDocuments += $groupDocuments
                }
            }
        }

        $page++
    } while ($response -and $response.items -and $response.items.Count -eq $pageSize)

    Write-Host "  Found $($allDocuments.Count) documents" -ForegroundColor Gray
    return $allDocuments
}

function Get-DocumentProperties {
    param(
        [string]$SiteURL,
        [string]$Token,
        [int]$DocumentId
    )

    $url = "$SiteURL/bff/document/api/v1/documents/$DocumentId/properties"
    $response = Invoke-ApiGet -Url $url -Token $Token
    return $response
}

function Test-DocumentHasAttachedProcesses {
    param(
        [string]$SiteURL,
        [string]$Token,
        [int]$DocumentId
    )

    $properties = Get-DocumentProperties -SiteURL $SiteURL -Token $Token -DocumentId $DocumentId

    if ($properties -and $properties.attachedProcesses -and $properties.attachedProcesses.Count -gt 0) {
        return $true
    }
    return $false
}

function Invoke-ArchiveDocument {
    param(
        [string]$SiteURL,
        [string]$Token,
        [int]$DocumentId
    )

    $url = "$SiteURL/bff/document/api/v1/documents/$DocumentId/archive"
    $response = Invoke-ApiPost -Url $url -Token $Token -Body @{}
    return $response
}

function Invoke-DeleteDocuments {
    param(
        [string]$SiteURL,
        [string]$Token,
        [array]$DocumentIds
    )

    if ($DocumentIds.Count -eq 0) {
        return $null
    }

    $url = "$SiteURL/bff/document/api/v1/documents/bulk"
    $body = @{
        documentIds = $DocumentIds
    }

    $response = Invoke-ApiDelete -Url $url -Token $Token -Body $body
    return $response
}

# ListType 7 is the archived process list. Everything that reads it goes through
# this one paginator: two copies existed with different page sizes, and Mode 5
# happened to use the 20-per-page one, which is 25 round trips for 497 processes
# where 3 will do.
$script:ArchivedPageSize = 200

function Get-ArchivedProcessItems {
    param(
        [string]$SiteURL,
        [string]$Token,
        [int]$GroupID = -1,
        [int]$PageSize = $script:ArchivedPageSize,
        [switch]$Quiet
    )

    $allProcesses = @()
    $page = 1

    do {
        $url = "$SiteURL/Bff/Process/api/v1/processes?Page=$page&PageSize=$PageSize&ListType=7"
        $response = Invoke-ApiGet -Url $url -Token $Token

        $items = @()
        if ($response -and $response.items) { $items = @($response.items) }

        if ($items.Count -gt 0 -and -not $Quiet) {
            Write-Host "    Page ${page}: $($items.Count) archived process(es)" -ForegroundColor Gray
        }

        if ($GroupID -gt 0) {
            $allProcesses += @($items | Where-Object { $_.groupId -eq $GroupID })
        } else {
            $allProcesses += $items
        }

        $page++
    } while ($items.Count -eq $PageSize)

    return $allProcesses
}

function Get-ArchivedProcesses {
    param(
        [string]$SiteURL,
        [string]$Token,
        [int]$GroupID = -1
    )

    Write-Host "  Fetching archived processes..." -ForegroundColor Gray
    $allProcesses = @(Get-ArchivedProcessItems -SiteURL $SiteURL -Token $Token -GroupID $GroupID)
    Write-Host "  Total archived processes: $($allProcesses.Count)" -ForegroundColor Gray
    return $allProcesses
}

# ============================================================================
# CSV PROCESSING
# ============================================================================

function Read-CsvWithFlexibleHeaders {
    param([string]$Path)

    if (-not (Test-Path $Path)) {
        Write-Host "CSV file not found: $Path" -ForegroundColor Red
        return $null
    }

    try {
        $csv = Import-Csv -Path $Path
        return $csv
    }
    catch {
        Write-Host "Error reading CSV: $($_.Exception.Message)" -ForegroundColor Red
        return $null
    }
}

function Get-IdFromCsvRow {
    param($Row)

    # Try various common column names for ID
    $possibleIdColumns = @('ProcessID', 'ProcessId', 'Process ID', 'ProcessUniqueId', 'Id', 'ID', 'DocumentID', 'DocumentId')

    foreach ($col in $possibleIdColumns) {
        if ($Row.PSObject.Properties.Name -contains $col) {
            return $Row.$col
        }
    }

    return $null
}

# Matches a Nintex process UniqueId (GUID) so we can tell GUIDs apart from numeric Process IDs
$script:ProcessGuidRegex = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

# Cache of numeric Process ID -> processUniqueId, built lazily on the first numeric lookup
$script:ProcessUniqueIdMap = $null

function Test-IsProcessGuid {
    param([string]$Value)
    return ($Value -and ($Value -match $script:ProcessGuidRegex))
}

function Get-ProcessUniqueIdMap {
    # Builds a numeric ID -> processUniqueId lookup by paging the process list
    # (ListType 0 = active, 7 = archived) so CSVs can use either numeric IDs or GUIDs.
    param(
        [string]$SiteURL,
        [string]$Token
    )

    $map = @{}
    foreach ($listType in @(0, 7)) {
        $page = 1
        $pageSize = 200
        do {
            $url = "$SiteURL/Bff/Process/api/v1/processes?Page=$page&PageSize=$pageSize&ListType=$listType"
            $response = Invoke-ApiGet -Url $url -Token $Token
            if ($response -and $response.items) {
                foreach ($item in $response.items) {
                    if ($null -ne $item.id -and $item.processUniqueId) {
                        $map["$($item.id)"] = $item.processUniqueId
                    }
                }
            }
            $page++
        } while ($response -and $response.items -and $response.items.Count -eq $pageSize)
    }
    return $map
}

function Resolve-ProcessUniqueId {
    # Returns the processUniqueId (GUID) for a numeric Process ID, or $null if not found.
    param(
        [string]$SiteURL,
        [string]$Token,
        [string]$NumericId
    )

    if ($null -eq $script:ProcessUniqueIdMap) {
        Write-Host "  Building Process ID lookup (numeric ID -> uniqueId)..." -ForegroundColor Gray
        $script:ProcessUniqueIdMap = Get-ProcessUniqueIdMap -SiteURL $SiteURL -Token $Token
        Write-Host "  Mapped $($script:ProcessUniqueIdMap.Count) processes" -ForegroundColor Gray
    }

    if ($script:ProcessUniqueIdMap.ContainsKey("$NumericId")) {
        return $script:ProcessUniqueIdMap["$NumericId"]
    }
    return $null
}

function Get-ProcessModel {
    # The /Api/v1/Processes/{id} endpoint returns the process under a "processJson"
    # wrapper; unwrap it (falling back to a flat response) so callers can read the
    # model's fields directly. PowerShell property access is case-insensitive, so
    # callers can use .uniqueId / .name / .isArchived against the PascalCase model.
    param($Response)

    if (-not $Response) { return $null }
    if ($Response.processJson) { return $Response.processJson }
    return $Response
}

function Get-ProcessById {
    # Fetches a process by CSV ID, accepting either a numeric Process ID or a GUID
    # processUniqueId. Tries a direct fetch first, then resolves numeric IDs to a GUID
    # and retries. Returns the process model (with UniqueId/Name/IsArchived) or $null.
    param(
        [string]$SiteURL,
        [string]$Token,
        [string]$Id
    )

    if (-not $Id) { return $null }

    # Direct fetch (works for GUIDs and, on some versions, numeric IDs)
    $model = Get-ProcessModel -Response (Invoke-ApiGet -Url "$SiteURL/Api/v1/Processes/$Id" -Token $Token)
    if ($model -and $model.uniqueId) { return $model }

    # Direct fetch didn't resolve. If the ID isn't a GUID, map numeric ID -> uniqueId and retry.
    if (-not (Test-IsProcessGuid -Value $Id)) {
        $uniqueId = Resolve-ProcessUniqueId -SiteURL $SiteURL -Token $Token -NumericId $Id
        if ($uniqueId) {
            $model = Get-ProcessModel -Response (Invoke-ApiGet -Url "$SiteURL/Api/v1/Processes/$uniqueId" -Token $Token)
            if ($model -and $model.uniqueId) { return $model }
        }
    }

    return $null
}

function Get-NewGroupIdFromCsvRow {
    param($Row)

    $possibleColumns = @('NewGroupID', 'NewGroupId', 'TargetGroupID', 'TargetGroupId', 'GroupID', 'GroupId')

    foreach ($col in $possibleColumns) {
        if ($Row.PSObject.Properties.Name -contains $col) {
            return $Row.$col
        }
    }

    return $null
}

function Get-NewOwnerFromCsvRow {
    param($Row)

    $possibleColumns = @('NewOwner', 'Owner', 'OwnerUsername', 'ProcessOwner')

    foreach ($col in $possibleColumns) {
        if ($Row.PSObject.Properties.Name -contains $col) {
            return $Row.$col
        }
    }

    return $null
}

function Get-NewExpertFromCsvRow {
    param($Row)

    $possibleColumns = @('NewExpert', 'Expert', 'ExpertUsername', 'ProcessExpert')

    foreach ($col in $possibleColumns) {
        if ($Row.PSObject.Properties.Name -contains $col) {
            return $Row.$col
        }
    }

    return $null
}

# ============================================================================
# USER AND GROUP SELECTION
# ============================================================================

function Get-ChildGroupsRecursive {
    param(
        [string]$SiteURL,
        [string]$Token,
        [string]$ParentUniqueId,
        [int]$ParentId = $null,
        [ref]$AllGroups
    )

    try {
        $url = "$SiteURL/Process/View/GetChildProcessGroupTreeItems?uniqueId=$ParentUniqueId"
        $response = Invoke-ApiGet -Url $url -Token $Token

        if ($response -and $response.treeItems) {
            # Filter for only group items (not processes or documents)
            $groups = $response.treeItems | Where-Object {
                $_.itemType -eq "group" -or $_.itemType -eq "documentgroup"
            }

            foreach ($group in $groups) {
                # Add this group to our collection
                if (-not $AllGroups.Value.ContainsKey($group.id)) {
                    $AllGroups.Value[$group.id] = @{
                        id = $group.id
                        uniqueId = $group.uniqueId
                        name = $group.title
                        parentId = $ParentId
                        hasChild = $group.hasChild
                        totalSubgroups = $group.totalSubgroups
                        itemOrder = $group.itemOrder
                    }
                }

                # Recursively fetch children if this group has any
                if ($group.hasChild -and $group.totalSubgroups -gt 0) {
                    Get-ChildGroupsRecursive -SiteURL $SiteURL -Token $Token `
                        -ParentUniqueId $group.uniqueId -ParentId $group.id `
                        -AllGroups $AllGroups
                }
            }
        }
    }
    catch {
        Write-Host "  Error fetching children for group $ParentUniqueId : $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

function Get-ProcessGroups {
    param(
        [string]$SiteURL,
        [string]$Token
    )

    try {
        Write-Host "Fetching group tree from Process Manager..." -ForegroundColor Cyan

        # Get root groups by calling GetChildProcessGroupTreeItems without uniqueId parameter
        $url = "$SiteURL/Process/View/GetChildProcessGroupTreeItems"
        $response = Invoke-ApiGet -Url $url -Token $Token

        if (-not $response -or -not $response.treeItems) {
            Write-Host "  Could not fetch root groups from API" -ForegroundColor Yellow
            return @()
        }

        # Filter for only group items (not processes or documents)
        $rootGroups = $response.treeItems | Where-Object {
            $_.itemType -eq "group" -or $_.itemType -eq "documentgroup"
        }

        # Now recursively fetch the full tree for each root group
        $allGroups = @{}
        $currentIndex = 0
        $totalRootGroups = $rootGroups.Count

        foreach ($rootGroup in $rootGroups) {
            $currentIndex++
            Write-Host "`r  Fetching group tree $currentIndex out of $totalRootGroups..." -NoNewline -ForegroundColor Gray

            # Add root group
            $allGroups[$rootGroup.id] = @{
                id = $rootGroup.id
                uniqueId = $rootGroup.uniqueId
                name = $rootGroup.title
                parentId = $null
                hasChild = $rootGroup.hasChild
                totalSubgroups = $rootGroup.totalSubgroups
                itemOrder = $rootGroup.itemOrder
            }

            # Recursively fetch children if this group has any
            if ($rootGroup.hasChild -and $rootGroup.totalSubgroups -gt 0) {
                Get-ChildGroupsRecursive -SiteURL $SiteURL -Token $Token `
                    -ParentUniqueId $rootGroup.uniqueId -ParentId $rootGroup.id `
                    -AllGroups ([ref]$allGroups)
            }
        }
        Write-Host ""  # New line after progress counter

        Write-Host "Successfully fetched $($allGroups.Count) groups total" -ForegroundColor Green
        return $allGroups.Values | Sort-Object -Property itemOrder
    }
    catch {
        Write-Host "Error fetching process groups: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host $_.ScriptStackTrace -ForegroundColor Red
        return @()
    }
}

function Get-ProcessGroupById {
    param(
        [string]$SiteURL,
        [string]$Token,
        [string]$GroupId  # Can be numeric ID or GUID
    )

    try {
        # Check if it's a GUID format
        $guidRegex = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        $isGuid = $GroupId -match $guidRegex

        if ($isGuid) {
            Write-Host "Looking up group by GUID: $GroupId" -ForegroundColor Gray

            # Try direct API endpoint first (most reliable)
            $directUrl = "$SiteURL/Api/v1/ProcessGroups/$GroupId"
            $directResponse = Invoke-ApiGet -Url $directUrl -Token $Token

            # Check multiple possible response structures
            if ($directResponse) {
                $groupJson = $null

                # Try different response structures
                if ($directResponse.processGroupJson) {
                    $groupJson = $directResponse.processGroupJson
                }
                elseif ($directResponse.id -or $directResponse.Id) {
                    # Response might be the group object directly
                    $groupJson = $directResponse
                }
                elseif ($directResponse.ProcessGroup) {
                    $groupJson = $directResponse.ProcessGroup
                }

                if ($groupJson -and ($groupJson.UniqueId -or $groupJson.uniqueId)) {
                    $name = if ($groupJson.Name) { $groupJson.Name } else { $groupJson.name }
                    $id = if ($groupJson.Id) { $groupJson.Id } else { $groupJson.id }
                    $uniqueId = if ($groupJson.UniqueId) { $groupJson.UniqueId } else { $groupJson.uniqueId }

                    Write-Host "Found group: $name" -ForegroundColor Green

                    return @{
                        id = $id
                        uniqueId = $uniqueId
                        name = $name
                    }
                }
            }

            # Fallback: Search the tree for the group (silently, since this is a normal fallback)
            $numericId = Get-GroupNumericIdFromTree -SiteURL $SiteURL -Token $Token -TargetUniqueId $GroupId

            if ($numericId -and $numericId -ne -1) {
                # We found the numeric ID, now get the full group details from the tree
                $group = Find-GroupInTreeByNumericId -SiteURL $SiteURL -Token $Token -TargetNumericId $numericId

                if ($group) {
                    Write-Host "Found group: $($group.name)" -ForegroundColor Green
                    return $group
                }
            }

            Write-Host "Could not find group with GUID: $GroupId" -ForegroundColor Red
            return $null
        }
        else {
            # Numeric ID - need to search the tree
            Write-Host "Looking up group by numeric ID: $GroupId" -ForegroundColor Gray

            # For numeric IDs, we still need to search the tree, but we can optimize
            # by using a targeted search that stops once found
            $numericId = [int]$GroupId
            $group = Find-GroupInTreeByNumericId -SiteURL $SiteURL -Token $Token -TargetNumericId $numericId

            if ($group) {
                Write-Host "Found group: $($group.name)" -ForegroundColor Green
                return $group
            }

            Write-Host "Could not find group with ID: $GroupId" -ForegroundColor Red
            return $null
        }
    }
    catch {
        Write-Host "Error looking up group: $($_.Exception.Message)" -ForegroundColor Red
        return $null
    }
}

function Get-GroupNumericIdFromTree {
    param(
        [string]$SiteURL,
        [string]$Token,
        [string]$TargetUniqueId
    )

    # This is an optimized search that checks root groups first, then searches deeper
    try {
        # First check root groups (fast)
        $url = "$SiteURL/Process/View/GetChildProcessGroupTreeItems"
        $response = Invoke-ApiGet -Url $url -Token $Token

        if ($response -and $response.treeItems) {
            $matchedGroup = $response.treeItems | Where-Object { $_.uniqueId -eq $TargetUniqueId }
            if ($matchedGroup) {
                return $matchedGroup.id
            }

            # Not in root groups, need to search children recursively
            foreach ($rootGroup in $response.treeItems) {
                if ($rootGroup.hasChild -and $rootGroup.totalSubgroups -gt 0) {
                    $found = Search-GroupTreeForUniqueId -SiteURL $SiteURL -Token $Token `
                        -ParentUniqueId $rootGroup.uniqueId -TargetUniqueId $TargetUniqueId

                    if ($found -ne -1) {
                        return $found
                    }
                }
            }
        }

        return -1
    }
    catch {
        Write-Host "Error searching for group numeric ID: $($_.Exception.Message)" -ForegroundColor Yellow
        return -1
    }
}

function Search-GroupTreeForUniqueId {
    param(
        [string]$SiteURL,
        [string]$Token,
        [string]$ParentUniqueId,
        [string]$TargetUniqueId
    )

    try {
        $url = "$SiteURL/Process/View/GetChildProcessGroupTreeItems?uniqueId=$ParentUniqueId"
        $response = Invoke-ApiGet -Url $url -Token $Token

        if ($response -and $response.treeItems) {
            # Check if target is in this level
            $matchedGroup = $response.treeItems | Where-Object { $_.uniqueId -eq $TargetUniqueId }
            if ($matchedGroup) {
                return $matchedGroup.id
            }

            # Search children recursively
            foreach ($group in $response.treeItems) {
                if ($group.hasChild -and $group.totalSubgroups -gt 0) {
                    $found = Search-GroupTreeForUniqueId -SiteURL $SiteURL -Token $Token `
                        -ParentUniqueId $group.uniqueId -TargetUniqueId $TargetUniqueId

                    if ($found -ne -1) {
                        return $found
                    }
                }
            }
        }

        return -1
    }
    catch {
        return -1
    }
}

function Find-GroupInTreeByNumericId {
    param(
        [string]$SiteURL,
        [string]$Token,
        [int]$TargetNumericId
    )

    try {
        # Get root groups
        $url = "$SiteURL/Process/View/GetChildProcessGroupTreeItems"
        $response = Invoke-ApiGet -Url $url -Token $Token

        if ($response -and $response.treeItems) {
            # Check root level first
            $matchedGroup = $response.treeItems | Where-Object { $_.id -eq $TargetNumericId }
            if ($matchedGroup) {
                return @{
                    id = $matchedGroup.id
                    uniqueId = $matchedGroup.uniqueId
                    name = $matchedGroup.title
                }
            }

            # Search children recursively
            foreach ($rootGroup in $response.treeItems) {
                if ($rootGroup.hasChild -and $rootGroup.totalSubgroups -gt 0) {
                    $found = Search-GroupTreeForNumericId -SiteURL $SiteURL -Token $Token `
                        -ParentUniqueId $rootGroup.uniqueId -TargetNumericId $TargetNumericId

                    if ($found) {
                        return $found
                    }
                }
            }
        }

        return $null
    }
    catch {
        Write-Host "Error searching for group by numeric ID: $($_.Exception.Message)" -ForegroundColor Yellow
        return $null
    }
}

function Search-GroupTreeForNumericId {
    param(
        [string]$SiteURL,
        [string]$Token,
        [string]$ParentUniqueId,
        [int]$TargetNumericId
    )

    try {
        $url = "$SiteURL/Process/View/GetChildProcessGroupTreeItems?uniqueId=$ParentUniqueId"
        $response = Invoke-ApiGet -Url $url -Token $Token

        if ($response -and $response.treeItems) {
            # Check if target is in this level
            $matchedGroup = $response.treeItems | Where-Object { $_.id -eq $TargetNumericId }
            if ($matchedGroup) {
                return @{
                    id = $matchedGroup.id
                    uniqueId = $matchedGroup.uniqueId
                    name = $matchedGroup.title
                }
            }

            # Search children recursively
            foreach ($group in $response.treeItems) {
                if ($group.hasChild -and $group.totalSubgroups -gt 0) {
                    $found = Search-GroupTreeForNumericId -SiteURL $SiteURL -Token $Token `
                        -ParentUniqueId $group.uniqueId -TargetNumericId $TargetNumericId

                    if ($found) {
                        return $found
                    }
                }
            }
        }

        return $null
    }
    catch {
        return $null
    }
}

function Get-GroupNumericIdByUniqueId {
    param(
        [string]$SiteURL,
        [string]$Token,
        [string]$UniqueId
    )

    try {
        Write-Host "    Looking for group with uniqueId: $UniqueId" -ForegroundColor Gray

        # Get root level groups only (lightweight call)
        $url = "$SiteURL/Process/View/GetChildProcessGroupTreeItems"
        $response = Invoke-ApiGet -Url $url -Token $Token

        if ($response -and $response.treeItems) {
            Write-Host "    Found $($response.treeItems.Count) root groups" -ForegroundColor Gray

            $matchedGroup = $response.treeItems | Where-Object { $_.uniqueId -eq $UniqueId }
            if ($matchedGroup) {
                Write-Host "    Found matching group with numeric ID: $($matchedGroup.id)" -ForegroundColor Gray
                return $matchedGroup.id
            } else {
                Write-Host "    No matching group found with that uniqueId" -ForegroundColor Yellow
            }
        } else {
            Write-Host "    No root groups returned from API" -ForegroundColor Yellow
        }
        return -1
    }
    catch {
        Write-Host "Error looking up group numeric ID: $($_.Exception.Message)" -ForegroundColor Red
        return -1
    }
}

function New-ProcessGroup {
    param(
        [string]$SiteURL,
        [string]$Token,
        [string]$GroupName,
        [string]$ParentGroupUniqueId = ""
    )

    try {
        Write-Host "Creating process group: $GroupName" -ForegroundColor Cyan

        # Step 1: Create the group
        $createUrl = "$SiteURL/Process/Edit/CreateGroup"
        $createBody = @{
            parentProcessGroupUniqueId = $ParentGroupUniqueId
        } | ConvertTo-Json

        Write-Host "  Step 1: Creating group..." -ForegroundColor Gray
        $createResponse = Invoke-ApiPost -Url $createUrl -Token $Token -Body $createBody

        if (-not $createResponse) {
            Write-Host "Failed to create group. No response from CreateGroup API." -ForegroundColor Red
            return $null
        }

        # Extract the new group's uniqueId from the response
        # The API returns "groupid" (lowercase) which is the uniqueId
        $newGroupUniqueId = $createResponse.groupid

        if (-not $newGroupUniqueId) {
            Write-Host "Failed to create group. Response did not contain groupid." -ForegroundColor Red
            return $null
        }

        Write-Host "  Group created with uniqueId: $newGroupUniqueId" -ForegroundColor Gray

        # Small delay to ensure group is fully created on server
        Start-Sleep -Milliseconds 500

        # Step 2: Look up the numeric ID (skipping rename to avoid API errors)
        Write-Host "  Step 2: Looking up numeric group ID..." -ForegroundColor Gray
        $numericId = Get-GroupNumericIdByUniqueId -SiteURL $SiteURL -Token $Token -UniqueId $newGroupUniqueId

        Write-Host "Successfully created group (ID: $numericId, uniqueId: $newGroupUniqueId)" -ForegroundColor Green
        Write-Host "  Note: Group created with default name. Will be deleted at end of process." -ForegroundColor Gray

        return @{
            id = $numericId
            uniqueId = $newGroupUniqueId
            name = $GroupName
        }
    }
    catch {
        Write-Host "Error creating process group: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host $_.ScriptStackTrace -ForegroundColor Red
        return $null
    }
}

function Delete-ProcessGroup {
    param(
        [string]$SiteURL,
        [string]$Token,
        [string]$GroupUniqueId,
        [switch]$Silent
    )

    try {
        if (-not $Silent) {
            Write-Host "Deleting process group (UniqueId: $GroupUniqueId)..." -ForegroundColor Gray
        }

        $deleteUrl = "$SiteURL/Process/Edit/DeleteGroup"
        $deleteBody = @{
            processGroupUniqueId = $GroupUniqueId
        }

        $result = Invoke-ApiPost -Url $deleteUrl -Token $Token -Body $deleteBody

        if ($result) {
            if (-not $Silent) {
                Write-Host "  Successfully deleted temporary group" -ForegroundColor Green
            }
            return $true
        } else {
            if (-not $Silent) {
                Write-Host "  Failed to delete group" -ForegroundColor Red
            }
            return $false
        }
    }
    catch {
        if (-not $Silent) {
            Write-Host "  Error deleting process group: $($_.Exception.Message)" -ForegroundColor Red
        }
        return $false
    }
}

function Get-GroupsInTree {
    param(
        [string]$SiteURL,
        [string]$Token,
        [string]$RootGroupUniqueId,
        [int]$RootGroupId = -1,
        [array]$AllGroups = @(),
        [bool]$IncludeRoot = $true
    )

    # Get all groups in the site (or use provided array)
    if ($AllGroups.Count -eq 0) {
        $AllGroups = Get-ProcessGroups -SiteURL $SiteURL -Token $Token
        if (-not $AllGroups) {
            Write-Host "Warning: Could not retrieve process groups" -ForegroundColor Yellow
            return @()
        }
    }

    Write-Host "  Searching for group with UniqueId: $RootGroupUniqueId" -ForegroundColor Gray

    # Find the root group
    $rootGroup = $null
    if ($RootGroupUniqueId) {
        $rootGroup = $AllGroups | Where-Object { $_.uniqueId -eq $RootGroupUniqueId } | Select-Object -First 1
    } elseif ($RootGroupId -gt 0) {
        $rootGroup = $AllGroups | Where-Object { $_.id -eq $RootGroupId } | Select-Object -First 1
    }

    if (-not $rootGroup) {
        Write-Host "  Warning: Could not find root group with UniqueId '$RootGroupUniqueId'" -ForegroundColor Yellow
        Write-Host "  Total groups available: $($AllGroups.Count)" -ForegroundColor Yellow
        return @()
    }

    Write-Host "  Found root group: '$($rootGroup.name)' (ID: $($rootGroup.id))" -ForegroundColor Gray

    # Recursive function to get all descendant groups with their depth
    function Get-DescendantGroups {
        param(
            [object]$ParentGroup,
            [array]$AllGroups,
            [int]$Depth = 0
        )

        $results = @()

        # Get direct children of this group
        $children = $AllGroups | Where-Object { $_.parentId -eq $ParentGroup.id }

        foreach ($child in $children) {
            # Add this child with its depth
            $results += [PSCustomObject]@{
                Group = $child
                Depth = $Depth
                UniqueId = $child.uniqueId
                Name = $child.name
                Id = $child.id
            }

            # Recursively get this child's descendants
            $childDescendants = Get-DescendantGroups -ParentGroup $child -AllGroups $AllGroups -Depth ($Depth + 1)
            $results += $childDescendants
        }

        return $results
    }

    # Get all descendants
    $groupsInTree = Get-DescendantGroups -ParentGroup $rootGroup -AllGroups $AllGroups -Depth 1

    Write-Host "  Found $($groupsInTree.Count) descendant group(s)" -ForegroundColor Gray

    # Include root group if requested
    if ($IncludeRoot) {
        $rootGroupInfo = [PSCustomObject]@{
            Group = $rootGroup
            Depth = 0
            UniqueId = $rootGroup.uniqueId
            Name = $rootGroup.name
            Id = $rootGroup.id
        }
        $groupsInTree = @($rootGroupInfo) + $groupsInTree
    }

    Write-Host "  Total groups to delete (including root): $($groupsInTree.Count)" -ForegroundColor Gray

    # Sort by depth descending (deepest first) so we delete children before parents
    # Use @() to ensure we always return an array (PowerShell unwraps single-element arrays from Sort-Object)
    $groupsInTree = @($groupsInTree | Sort-Object -Property Depth -Descending)

    return $groupsInTree
}

function Show-GroupTree {
    param(
        [array]$Groups,
        [int]$ParentId = $null,
        [int]$Level = 0,
        [hashtable]$IndexMap
    )

    $indent = "  " * $Level
    $filteredGroups = $Groups | Where-Object {
        if ($ParentId -eq $null -or $ParentId -eq 0) {
            $_.parentId -eq $null -or $_.parentId -eq 0
        } else {
            $_.parentId -eq $ParentId
        }
    } | Sort-Object -Property itemOrder

    foreach ($group in $filteredGroups) {
        $index = $IndexMap.Count + 1
        $IndexMap[$index] = $group

        $groupName = if ($group.name) { $group.name } else { "Group $($group.id)" }
        $uniqueIdDisplay = if ($group.uniqueId) { " (ID: $($group.uniqueId))" } else { "" }

        Write-Host "$indent[$index] $groupName$uniqueIdDisplay" -ForegroundColor Cyan

        # Recursively show children
        Show-GroupTree -Groups $Groups -ParentId $group.id -Level ($Level + 1) -IndexMap $IndexMap
    }
}

function Select-ProcessGroup {
    param(
        [string]$SiteURL,
        [string]$Token,
        [string]$Prompt = "Select Process Group"
    )

    Write-Host "`n$Prompt" -ForegroundColor Cyan
    Write-Host "======================================" -ForegroundColor Gray
    Write-Host "[1] Select from group tree" -ForegroundColor White
    Write-Host "[2] Enter Group ID manually" -ForegroundColor White
    Write-Host "======================================" -ForegroundColor Gray

    $choice = Read-Host "Choose an option (1-2)"

    if ($choice -eq "1") {
        # Show group tree picker
        Write-Host "`nFetching process groups..." -ForegroundColor Cyan
        $groups = Get-ProcessGroups -SiteURL $SiteURL -Token $Token

        if (-not $groups -or $groups.Count -eq 0) {
            Write-Host "No groups found. Please enter Group ID manually." -ForegroundColor Yellow
            $choice = "2"
        } else {
            Write-Host "`nAvailable Process Groups:" -ForegroundColor Green
            Write-Host "======================================" -ForegroundColor Gray

            $indexMap = @{}
            Show-GroupTree -Groups $groups -IndexMap $indexMap

            Write-Host "======================================" -ForegroundColor Gray
            $selection = Read-Host "`nEnter the number of the group you want to select"

            if ($indexMap.ContainsKey([int]$selection)) {
                $selectedGroup = $indexMap[[int]$selection]
                $groupName = if ($selectedGroup.name) { $selectedGroup.name } else { "Group $($selectedGroup.id)" }
                Write-Host "Selected: $groupName" -ForegroundColor Green
                return $selectedGroup
            } else {
                Write-Host "Invalid selection." -ForegroundColor Red
                return $null
            }
        }
    }

    if ($choice -eq "2") {
        # Manual entry - OPTIMIZED: Use direct lookup instead of fetching entire tree
        Write-Host "`nEnter Process Group ID" -ForegroundColor Cyan
        Write-Host "You can find the Group ID in the URL when viewing a group in Process Manager" -ForegroundColor Gray
        Write-Host "Examples:" -ForegroundColor Gray
        Write-Host "  - Numeric ID: .../ProcessGroup/View/123 - enter: 123" -ForegroundColor Gray
        Write-Host "  - GUID: .../ProcessGroup/View/a1b2c3d4-... - enter: a1b2c3d4-e5f6-7890-abcd-ef1234567890" -ForegroundColor Gray

        $groupId = Read-Host "`nGroup ID"

        # Validate format first
        $isNumeric = $groupId -match '^\d+$'
        $isGuid = $groupId -match '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

        if (-not ($isNumeric -or $isGuid)) {
            Write-Host "Invalid Group ID format. Must be a number or a GUID." -ForegroundColor Red
            return $null
        }

        # Use optimized lookup function that doesn't fetch entire tree
        $matchedGroup = Get-ProcessGroupById -SiteURL $SiteURL -Token $Token -GroupId $groupId

        if ($matchedGroup) {
            return $matchedGroup
        } else {
            return $null
        }
    }

    Write-Host "Invalid choice." -ForegroundColor Red
    return $null
}

function Search-User {
    param(
        [string]$SiteURL,
        [string]$Token,
        [string]$SearchTerm
    )

    try {
        $url = "$SiteURL/user/autocomplete.aspx?includeEmail=true&term=$SearchTerm"
        $headers = @{
            "Authorization" = "Bearer $Token"
        }
        $response = Invoke-RestMethod -Uri $url -Method Get -Headers $headers
        return $response
    }
    catch {
        Write-Host "User search error: $($_.Exception.Message)" -ForegroundColor Red
        return @()
    }
}

function Select-User {
    param(
        [string]$SiteURL,
        [string]$Token,
        [string]$Prompt = "Enter username or search term"
    )

    Write-Host "`n$Prompt" -ForegroundColor Cyan
    $searchTerm = Read-Host "Search"

    if (-not $searchTerm) {
        return $null
    }

    $users = Search-User -SiteURL $SiteURL -Token $Token -SearchTerm $searchTerm

    if (-not $users -or $users.Count -eq 0) {
        Write-Host "No users found matching '$searchTerm'" -ForegroundColor Yellow
        return $null
    }

    Write-Host "`nFound users:" -ForegroundColor Green
    for ($i = 0; $i -lt $users.Count; $i++) {
        Write-Host "  [$i] $($users[$i].label)" -ForegroundColor White
    }

    $selection = Read-Host "`nSelect user number (or press Enter to cancel)"

    if ($selection -match '^\d+$' -and [int]$selection -lt $users.Count) {
        return $users[[int]$selection]
    }

    return $null
}

# ============================================================================
# MODE 1: BULK ARCHIVE
# ============================================================================

function Invoke-BulkArchive {
    param(
        [string]$SiteURL,
        [string]$Token,
        [string]$SourceType,  # "CSV" or "Group"
        [string]$ObjectType,  # "Processes", "Documents", or "Both"
        [string]$CsvPath = "",
        [int]$GroupID = -1,
        [string]$GroupUniqueId = "",
        [switch]$WhatIf
    )

    Write-Host "`n========================================" -ForegroundColor Cyan
    if ($WhatIf) {
        Write-Host "BULK ARCHIVE OPERATION (DRY-RUN PREVIEW)" -ForegroundColor Yellow
        Write-Host "========================================" -ForegroundColor Cyan
        Write-Host "*** PREVIEW MODE: No changes will be made ***" -ForegroundColor Yellow
    } else {
        Write-Host "BULK ARCHIVE OPERATION" -ForegroundColor Cyan
        Write-Host "========================================" -ForegroundColor Cyan
    }

    $results = @()
    $processesToArchive = @()
    $documentsToArchive = @()

    # Gather items to archive
    if ($SourceType -eq "CSV") {
        $csv = Read-CsvWithFlexibleHeaders -Path $CsvPath
        if (-not $csv) { return }

        foreach ($row in $csv) {
            $id = Get-IdFromCsvRow -Row $row
            if ($id) {
                if ($ObjectType -eq "Processes" -or $ObjectType -eq "Both") {
                    $processesToArchive += $id
                }
                if ($ObjectType -eq "Documents" -or $ObjectType -eq "Both") {
                    $documentsToArchive += $id
                }
            }
        }
    }
    else {  # Group-based
        if ($ObjectType -eq "Processes" -or $ObjectType -eq "Both") {
            $includeSubgroups = if ($script:CliOptions.NonInteractive) { [bool]$script:CliOptions.IncludeSubgroups }
                                else { (Read-Host "Include subgroups? (Y/N)") -eq 'Y' }
            $processes = Get-ProcessesFromGroup -SiteURL $SiteURL -Token $Token -GroupID $GroupID -GroupUniqueId $GroupUniqueId -IncludeSubgroups $includeSubgroups
            $processesToArchive = $processes | ForEach-Object { $_.processUniqueId }
            Write-Host "Found $($processesToArchive.Count) processes to archive" -ForegroundColor Green
        }

        if ($ObjectType -eq "Documents" -or $ObjectType -eq "Both") {
            $includeSubgroups = if ($script:CliOptions.NonInteractive) { [bool]$script:CliOptions.IncludeSubgroups }
                                else { (Read-Host "Include subgroups for documents? (Y/N)") -eq 'Y' }
            $documents = Get-DocumentsFromGroup -SiteURL $SiteURL -Token $Token -GroupID $GroupID -IncludeSubgroups $includeSubgroups
            $documentsToArchive = $documents | ForEach-Object { $_.id }
            Write-Host "Found $($documentsToArchive.Count) documents to archive" -ForegroundColor Green
        }
    }

    # Archive processes
    if ($processesToArchive.Count -gt 0) {
        if ($WhatIf) {
            Write-Host "`n[PREVIEW] Would archive $($processesToArchive.Count) processes..." -ForegroundColor Yellow
        } else {
            Write-Host "`nArchiving $($processesToArchive.Count) processes..." -ForegroundColor Cyan
        }

        $currentIndex = 0
        $totalProcesses = $processesToArchive.Count

        foreach ($processId in $processesToArchive) {
            $currentIndex++
            if ($WhatIf) {
                Write-Host "`r  [PREVIEW] Checking Process $currentIndex of $totalProcesses..." -NoNewline -ForegroundColor Yellow
            } else {
                Write-Host "`r  Archiving Process $currentIndex of $totalProcesses..." -NoNewline -ForegroundColor Gray
            }

            # Fetch process details to get uniqueId (accepts numeric Process IDs or GUIDs)
            $process = Get-ProcessById -SiteURL $SiteURL -Token $Token -Id $processId

            if ($process -and $process.uniqueId) {
                $processUniqueId = $process.uniqueId

                if ($WhatIf) {
                    # Dry-run: Show what would happen
                    $processName = if ($process.name) { $process.name } else { "Unknown" }
                    $archiveStatus = if ($process.isArchived) { "Already Archived" } else { "Would Archive" }

                    $results += [PSCustomObject]@{
                        ObjectType = "Process"
                        ObjectID = $processId
                        Operation = "Archive"
                        Status = "Preview"
                        Message = "$archiveStatus - $processName"
                    }
                } else {
                    # Actual operation
                    $result = Archive-Process -SiteURL $SiteURL -Token $Token -ProcessUniqueId $processUniqueId -Comment "Bulk archive operation"

                    if ($result) {
                        # Verify archive
                        $process = Get-ProcessById -SiteURL $SiteURL -Token $Token -Id $processUniqueId
                        if ($process -and $process.isArchived) {
                            $results += [PSCustomObject]@{
                                ObjectType = "Process"
                                ObjectID = $processId
                                Operation = "Archive"
                                Status = "Success"
                                Message = "Archived successfully"
                            }
                        } else {
                            $results += [PSCustomObject]@{
                                ObjectType = "Process"
                                ObjectID = $processId
                                Operation = "Archive"
                                Status = "Failed"
                                Message = "Could not archive"
                            }
                        }
                    } else {
                        $results += [PSCustomObject]@{
                            ObjectType = "Process"
                            ObjectID = $processId
                            Operation = "Archive"
                            Status = "Failed"
                            Message = "Archive API call failed"
                        }
                    }
                }
            } else {
                $results += [PSCustomObject]@{
                    ObjectType = "Process"
                    ObjectID = $processId
                    Operation = "Archive"
                    Status = "Failed"
                    Message = "Could not retrieve process"
                }
            }
        }
        Write-Host ""  # New line after progress counter
    }

    # Archive documents (if applicable)
    if ($documentsToArchive.Count -gt 0) {
        if ($WhatIf) {
            Write-Host "`n[PREVIEW] Would archive $($documentsToArchive.Count) documents..." -ForegroundColor Yellow
        } else {
            Write-Host "`nArchiving $($documentsToArchive.Count) documents..." -ForegroundColor Cyan
        }
        Write-Host "Note: Document archiving may not be supported in all Nintex PM versions" -ForegroundColor Yellow

        $currentIndex = 0
        $totalDocuments = $documentsToArchive.Count

        foreach ($docId in $documentsToArchive) {
            $currentIndex++
            if ($WhatIf) {
                Write-Host "`r  [PREVIEW] Checking Document $currentIndex of $totalDocuments..." -NoNewline -ForegroundColor Yellow
            } else {
                Write-Host "`r  Archiving Document $currentIndex of $totalDocuments..." -NoNewline -ForegroundColor Gray
            }

            if ($WhatIf) {
                # Dry-run: Preview
                $results += [PSCustomObject]@{
                    ObjectType = "Document"
                    ObjectID = $docId
                    Operation = "Archive"
                    Status = "Preview"
                    Message = "Would Archive"
                }
            } else {
                # Actual operation
                $archiveUrl = "$SiteURL/Api/v1/Documents/$docId/Archive"
                $result = Invoke-ApiPost -Url $archiveUrl -Token $Token

                if ($result) {
                    $results += [PSCustomObject]@{
                        ObjectType = "Document"
                        ObjectID = $docId
                        Operation = "Archive"
                        Status = "Success"
                        Message = "Archived"
                    }
                } else {
                    $results += [PSCustomObject]@{
                        ObjectType = "Document"
                        ObjectID = $docId
                        Operation = "Archive"
                        Status = "Failed"
                        Message = "Archive failed"
                    }
                }
            }
        }
        Write-Host ""  # New line after progress counter
    }

    # Save results
    $timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
    if ($WhatIf) {
        $outputPath = "Archive_Preview_$timestamp.csv"
    } else {
        $outputPath = "Archive_Results_$timestamp.csv"
    }
    $results | Export-Csv -Path $outputPath -NoTypeInformation

    Write-Host ""
    if ($WhatIf) {
        Write-Host "Preview results saved to: $outputPath" -ForegroundColor Yellow
        Write-Host "Total items checked: $($results.Count)" -ForegroundColor Cyan
        Write-Host "Would archive: $(($results | Where-Object {$_.Status -eq 'Preview' -and $_.Message -like 'Would Archive*'}).Count)" -ForegroundColor Yellow
        Write-Host "Already archived: $(($results | Where-Object {$_.Status -eq 'Preview' -and $_.Message -like 'Already Archived*'}).Count)" -ForegroundColor Gray
        Write-Host "Failed to check: $(($results | Where-Object {$_.Status -eq 'Failed'}).Count)" -ForegroundColor Red
        Write-Host ""
        Write-Host "*** This was a PREVIEW - no changes were made ***" -ForegroundColor Yellow
    } else {
        Write-Host "Results saved to: $outputPath" -ForegroundColor Green
        Write-Host "Total operations: $($results.Count)" -ForegroundColor Cyan
        Write-Host "Successful: $(($results | Where-Object {$_.Status -eq 'Success'}).Count)" -ForegroundColor Green
        Write-Host "Failed: $(($results | Where-Object {$_.Status -eq 'Failed'}).Count)" -ForegroundColor Red
    }
}

# ============================================================================
# MODE 2: BULK RESTORE
# ============================================================================

function Invoke-BulkRestore {
    param(
        [string]$SiteURL,
        [string]$Token,
        [string]$SourceType,  # "CSV" or "All"
        [string]$ObjectType,  # "Processes", "Documents", or "Both"
        [string]$CsvPath = "",
        [int]$RestoreGroupID,
        [switch]$WhatIf
    )

    Write-Host "`n========================================" -ForegroundColor Cyan
    if ($WhatIf) {
        Write-Host "BULK RESTORE OPERATION (DRY-RUN PREVIEW)" -ForegroundColor Yellow
        Write-Host "========================================" -ForegroundColor Cyan
        Write-Host "*** PREVIEW MODE: No changes will be made ***" -ForegroundColor Yellow
    } else {
        Write-Host "BULK RESTORE OPERATION" -ForegroundColor Cyan
        Write-Host "========================================" -ForegroundColor Cyan
    }

    $results = @()
    $processesToRestore = @()
    $documentsToRestore = @()

    # Gather items to restore
    if ($SourceType -eq "CSV") {
        $csv = Read-CsvWithFlexibleHeaders -Path $CsvPath
        if (-not $csv) { return }

        foreach ($row in $csv) {
            $id = Get-IdFromCsvRow -Row $row
            if ($id) {
                if ($ObjectType -eq "Processes" -or $ObjectType -eq "Both") {
                    $processesToRestore += $id
                }
                if ($ObjectType -eq "Documents" -or $ObjectType -eq "Both") {
                    $documentsToRestore += $id
                }
            }
        }
    }
    else {  # Restore all archived items
        if ($ObjectType -eq "Processes" -or $ObjectType -eq "Both") {
            $processes = Get-ArchivedProcesses -SiteURL $SiteURL -Token $Token
            $processesToRestore = $processes | ForEach-Object { $_.processUniqueId }
            Write-Host "Found $($processesToRestore.Count) archived processes" -ForegroundColor Green
        }

        if ($ObjectType -eq "Documents" -or $ObjectType -eq "Both") {
            Write-Host "Restoring all archived documents not yet implemented" -ForegroundColor Yellow
        }
    }

    # Restore processes
    if ($processesToRestore.Count -gt 0) {
        if ($WhatIf) {
            Write-Host "`n[PREVIEW] Would restore $($processesToRestore.Count) processes to Group ID: $RestoreGroupID..." -ForegroundColor Yellow
        } else {
            Write-Host "`nRestoring $($processesToRestore.Count) processes to Group ID: $RestoreGroupID..." -ForegroundColor Cyan
        }

        $currentIndex = 0
        $totalProcesses = $processesToRestore.Count

        foreach ($processId in $processesToRestore) {
            $currentIndex++
            if ($WhatIf) {
                Write-Host "`r  [PREVIEW] Checking Process $currentIndex of $totalProcesses..." -NoNewline -ForegroundColor Yellow
            } else {
                Write-Host "`r  Restoring Process $currentIndex of $totalProcesses..." -NoNewline -ForegroundColor Gray
            }

            # Fetch process details to check current status
            $verifyUrl = "$SiteURL/Api/v1/Processes/$processId"
            $process = Invoke-ApiGet -Url $verifyUrl -Token $Token

            if ($WhatIf) {
                # Dry-run: Show what would happen
                if ($process) {
                    $processName = if ($process.name) { $process.name } else { "Unknown" }
                    $restoreStatus = if ($process.isArchived) { "Would Restore" } else { "Already Active" }

                    $results += [PSCustomObject]@{
                        ObjectType = "Process"
                        ObjectID = $processId
                        Operation = "Restore"
                        Status = "Preview"
                        Message = "$restoreStatus - $processName"
                        ActionUrl = "$SiteURL/Process/View/$processId"
                    }
                } else {
                    $results += [PSCustomObject]@{
                        ObjectType = "Process"
                        ObjectID = $processId
                        Operation = "Restore"
                        Status = "Failed"
                        Message = "Could not retrieve process"
                        ActionUrl = ""
                    }
                }
            } else {
                # Actual operation
                $restoreUrl = "$SiteURL/Process/Edit/RestoreProcess"
                $restoreBody = @{
                    processUniqueId = $processId
                    processGroupId = $RestoreGroupID.ToString()
                }
                $result = Invoke-ApiPost -Url $restoreUrl -Token $Token -Body $restoreBody

                if ($result) {
                    # Verify restore
                    $process = Invoke-ApiGet -Url $verifyUrl -Token $Token

                    if ($process -and -not $process.isArchived) {
                        $results += [PSCustomObject]@{
                            ObjectType = "Process"
                            ObjectID = $processId
                            Operation = "Restore"
                            Status = "Success"
                            Message = "Restored to Group $RestoreGroupID"
                            ActionUrl = "$SiteURL/Process/View/$processId"
                        }
                    } else {
                        $results += [PSCustomObject]@{
                            ObjectType = "Process"
                            ObjectID = $processId
                            Operation = "Restore"
                            Status = "Failed"
                            Message = "Verification failed"
                            ActionUrl = ""
                        }
                    }
                } else {
                    $results += [PSCustomObject]@{
                        ObjectType = "Process"
                        ObjectID = $processId
                        Operation = "Restore"
                        Status = "Failed"
                        Message = "Restore API call failed"
                        ActionUrl = ""
                    }
                }
            }
        }
        Write-Host ""  # New line after progress counter
    }

    # Restore documents
    if ($documentsToRestore.Count -gt 0) {
        Write-Host "`nRestoring $($documentsToRestore.Count) documents..." -ForegroundColor Cyan
        foreach ($docId in $documentsToRestore) {
            Write-Host "Document restore for ID $docId - Not yet implemented" -ForegroundColor Yellow
            $results += [PSCustomObject]@{
                ObjectType = "Document"
                ObjectID = $docId
                Operation = "Restore"
                Status = "Skipped"
                Message = "Not implemented"
                ActionUrl = ""
            }
        }
    }

    # Save results
    $timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
    if ($WhatIf) {
        $outputPath = "Restore_Preview_$timestamp.csv"
    } else {
        $outputPath = "Restore_Results_$timestamp.csv"
    }
    $results | Export-Csv -Path $outputPath -NoTypeInformation

    Write-Host ""
    if ($WhatIf) {
        Write-Host "Preview results saved to: $outputPath" -ForegroundColor Yellow
        Write-Host "Total items checked: $($results.Count)" -ForegroundColor Cyan
        Write-Host "Would restore: $(($results | Where-Object {$_.Status -eq 'Preview' -and $_.Message -like 'Would Restore*'}).Count)" -ForegroundColor Yellow
        Write-Host "Already active: $(($results | Where-Object {$_.Status -eq 'Preview' -and $_.Message -like 'Already Active*'}).Count)" -ForegroundColor Gray
        Write-Host "Failed to check: $(($results | Where-Object {$_.Status -eq 'Failed'}).Count)" -ForegroundColor Red
        Write-Host ""
        Write-Host "*** This was a PREVIEW - no changes were made ***" -ForegroundColor Yellow
    } else {
        Write-Host "Results saved to: $outputPath" -ForegroundColor Green
        Write-Host "Total operations: $($results.Count)" -ForegroundColor Cyan
        Write-Host "Successful: $(($results | Where-Object {$_.Status -eq 'Success'}).Count)" -ForegroundColor Green
        Write-Host "Failed: $(($results | Where-Object {$_.Status -eq 'Failed'}).Count)" -ForegroundColor Red
    }
}

# ============================================================================
# MODE 3: BULK UPDATE LOCATION
# ============================================================================

function Invoke-BulkUpdateLocation {
    param(
        [string]$SiteURL,
        [string]$Token,
        [string]$ObjectType,  # "Processes", "Documents", or "Both"
        [string]$CsvPath,
        [switch]$WhatIf
    )

    Write-Host "`n========================================" -ForegroundColor Cyan
    if ($WhatIf) {
        Write-Host "BULK UPDATE LOCATION OPERATION (DRY-RUN PREVIEW)" -ForegroundColor Yellow
        Write-Host "========================================" -ForegroundColor Cyan
        Write-Host "*** PREVIEW MODE: No changes will be made ***" -ForegroundColor Yellow
    } else {
        Write-Host "BULK UPDATE LOCATION OPERATION" -ForegroundColor Cyan
        Write-Host "========================================" -ForegroundColor Cyan
    }
    Write-Host "CSV should contain: ID column and NewGroupID column" -ForegroundColor Yellow

    $csv = Read-CsvWithFlexibleHeaders -Path $CsvPath
    if (-not $csv) { return }

    # Pre-flight validation: Check that all target groups exist
    Write-Host "`nValidating target groups..." -ForegroundColor Cyan
    $uniqueGroupIds = @()
    foreach ($row in $csv) {
        $groupId = Get-NewGroupIdFromCsvRow -Row $row
        if ($groupId -and $uniqueGroupIds -notcontains $groupId) {
            $uniqueGroupIds += $groupId
        }
    }

    Write-Host "Found $($uniqueGroupIds.Count) unique target group(s) to validate" -ForegroundColor Gray
    $invalidGroups = @()
    $validatedGroups = @{}  # Cache validated groups

    foreach ($groupId in $uniqueGroupIds) {
        # Try to lookup the group
        $group = Get-ProcessGroupById -SiteURL $SiteURL -Token $Token -GroupId $groupId

        if ($group) {
            $validatedGroups[$groupId] = $group
            Write-Host "  [OK] Group $groupId exists: $($group.name)" -ForegroundColor Green
        } else {
            $invalidGroups += $groupId
            Write-Host "  [X] Group $groupId not found" -ForegroundColor Red
        }
    }

    if ($invalidGroups.Count -gt 0) {
        Write-Host "`nWarning: $($invalidGroups.Count) target group(s) not found:" -ForegroundColor Yellow
        foreach ($invalidGroup in $invalidGroups) {
            Write-Host "  - $invalidGroup" -ForegroundColor Yellow
        }
        Write-Host ""
        $continue = 'N'
        if (-not $script:CliOptions.NonInteractive) {
            $continue = Read-Host "Continue anyway? Rows with invalid groups will fail. (Y/N)"
        } else {
            Write-Host "Running unattended; not continuing past unresolved target groups." -ForegroundColor Red
        }
        if ($continue -ne 'Y') {
            Write-Host "Operation cancelled" -ForegroundColor Yellow
            return
        }
    } else {
        Write-Host "All target groups validated successfully" -ForegroundColor Green
    }

    $results = @()
    $currentIndex = 0
    $totalRows = $csv.Count

    if ($WhatIf) {
        Write-Host "`n[PREVIEW] Checking $totalRows rows..." -ForegroundColor Yellow
    } else {
        Write-Host "`nProcessing $totalRows rows..." -ForegroundColor Cyan
    }

    foreach ($row in $csv) {
        $currentIndex++
        if ($WhatIf) {
            Write-Host "`r  [PREVIEW] Checking row $currentIndex of $totalRows..." -NoNewline -ForegroundColor Yellow
        } else {
            Write-Host "`r  Processing row $currentIndex of $totalRows..." -NoNewline -ForegroundColor Gray
        }

        $objectId = Get-IdFromCsvRow -Row $row
        $newGroupId = Get-NewGroupIdFromCsvRow -Row $row

        if (-not $objectId -or -not $newGroupId) {
            $results += [PSCustomObject]@{
                ObjectType = "Unknown"
                ObjectID = "N/A"
                Operation = "UpdateLocation"
                Status = "Skipped"
                Message = "Missing ID or NewGroupID"
                ActionUrl = ""
            }
            continue
        }

        if ($ObjectType -eq "Processes" -or $ObjectType -eq "Both") {

            # Get current process
            $getUrl = "$SiteURL/Api/v1/Processes/$objectId"
            $process = Invoke-ApiGet -Url $getUrl -Token $Token

            if ($process) {
                if ($WhatIf) {
                    # Dry-run: Show what would happen
                    $processName = if ($process.name) { $process.name } else { "Unknown" }
                    $currentGroupId = if ($process.processGroupId) { $process.processGroupId } else { "Unknown" }
                    $targetGroupName = if ($validatedGroups[$newGroupId]) { $validatedGroups[$newGroupId].name } else { $newGroupId }

                    $results += [PSCustomObject]@{
                        ObjectType = "Process"
                        ObjectID = $objectId
                        Operation = "UpdateLocation"
                        Status = "Preview"
                        Message = "Would move '$processName' from Group $currentGroupId to $targetGroupName"
                        ActionUrl = "$SiteURL/Process/View/$objectId"
                    }
                } else {
                    # Actual operation
                    $process.processGroupId = [int]$newGroupId

                    $updateUrl = "$SiteURL/Api/v1/Processes/$objectId"
                    $updateResult = Invoke-ApiPut -Url $updateUrl -Token $Token -Body $process

                    if ($updateResult -and $updateResult.Success) {
                        $results += [PSCustomObject]@{
                            ObjectType = "Process"
                            ObjectID = $objectId
                            Operation = "UpdateLocation"
                            Status = "Success"
                            Message = "Moved to Group $newGroupId"
                            ActionUrl = "$SiteURL/Process/View/$objectId"
                        }
                    } else {
                        $results += [PSCustomObject]@{
                            ObjectType = "Process"
                            ObjectID = $objectId
                            Operation = "UpdateLocation"
                            Status = "Failed"
                            Message = "Update failed"
                            ActionUrl = ""
                        }
                    }
                }
            } else {
                $results += [PSCustomObject]@{
                    ObjectType = "Process"
                    ObjectID = $objectId
                    Operation = "UpdateLocation"
                    Status = "Failed"
                    Message = "Process not found"
                    ActionUrl = ""
                }
            }
        }

        if ($ObjectType -eq "Documents" -or $ObjectType -eq "Both") {
            $results += [PSCustomObject]@{
                ObjectType = "Document"
                ObjectID = $objectId
                Operation = "UpdateLocation"
                Status = "Skipped"
                Message = "Not implemented"
                ActionUrl = ""
            }
        }
    }
    Write-Host ""  # New line after progress counter

    # Save results
    $timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
    if ($WhatIf) {
        $outputPath = "UpdateLocation_Preview_$timestamp.csv"
    } else {
        $outputPath = "UpdateLocation_Results_$timestamp.csv"
    }
    $results | Export-Csv -Path $outputPath -NoTypeInformation

    Write-Host ""
    if ($WhatIf) {
        Write-Host "Preview results saved to: $outputPath" -ForegroundColor Yellow
        Write-Host "Total items checked: $($results.Count)" -ForegroundColor Cyan
        Write-Host "Would update location: $(($results | Where-Object {$_.Status -eq 'Preview'}).Count)" -ForegroundColor Yellow
        Write-Host "Skipped: $(($results | Where-Object {$_.Status -eq 'Skipped'}).Count)" -ForegroundColor Gray
        Write-Host "Failed to check: $(($results | Where-Object {$_.Status -eq 'Failed'}).Count)" -ForegroundColor Red
        Write-Host ""
        Write-Host "*** This was a PREVIEW - no changes were made ***" -ForegroundColor Yellow
    } else {
        Write-Host "Results saved to: $outputPath" -ForegroundColor Green
        Write-Host "Total operations: $($results.Count)" -ForegroundColor Cyan
        Write-Host "Successful: $(($results | Where-Object {$_.Status -eq 'Success'}).Count)" -ForegroundColor Green
        Write-Host "Failed: $(($results | Where-Object {$_.Status -eq 'Failed'}).Count)" -ForegroundColor Red
    }
}

# ============================================================================
# MODE 4: BULK UPDATE OWNERSHIP
# ============================================================================

function Invoke-BulkUpdateOwnership {
    param(
        [string]$SiteURL,
        [string]$Token,
        [string]$CsvPath,
        [switch]$WhatIf
    )

    Write-Host "`n========================================" -ForegroundColor Cyan
    if ($WhatIf) {
        Write-Host "BULK UPDATE OWNERSHIP OPERATION (DRY-RUN PREVIEW)" -ForegroundColor Yellow
        Write-Host "========================================" -ForegroundColor Cyan
        Write-Host "*** PREVIEW MODE: No changes will be made ***" -ForegroundColor Yellow
    } else {
        Write-Host "BULK UPDATE OWNERSHIP OPERATION" -ForegroundColor Cyan
        Write-Host "========================================" -ForegroundColor Cyan
    }
    Write-Host "CSV should contain: ProcessID, NewOwner (username), NewExpert (username)" -ForegroundColor Yellow
    Write-Host "Note: Currently supports Processes only" -ForegroundColor Yellow

    $csv = Read-CsvWithFlexibleHeaders -Path $CsvPath
    if (-not $csv) { return }

    # Pre-flight validation: Check that all users exist
    Write-Host "`nValidating users..." -ForegroundColor Cyan
    $uniqueOwners = @()
    $uniqueExperts = @()

    foreach ($row in $csv) {
        $owner = Get-NewOwnerFromCsvRow -Row $row
        $expert = Get-NewExpertFromCsvRow -Row $row

        if ($owner -and $uniqueOwners -notcontains $owner) {
            $uniqueOwners += $owner
        }
        if ($expert -and $uniqueExperts -notcontains $expert) {
            $uniqueExperts += $expert
        }
    }

    $allUniqueUsers = ($uniqueOwners + $uniqueExperts) | Select-Object -Unique
    Write-Host "Found $($allUniqueUsers.Count) unique user(s) to validate" -ForegroundColor Gray

    $invalidUsers = @()
    $validatedUsers = @{}  # Cache validated users

    foreach ($username in $allUniqueUsers) {
        # Search for the user
        $users = Search-User -SiteURL $SiteURL -Token $Token -SearchTerm $username

        # Check if exact match exists
        $exactMatch = $users | Where-Object { $_.value -eq $username }

        if ($exactMatch) {
            $validatedUsers[$username] = $exactMatch
            Write-Host "  [OK] User '$username' exists: $($exactMatch.label)" -ForegroundColor Green
        } else {
            $invalidUsers += $username
            Write-Host "  [X] User '$username' not found" -ForegroundColor Red
        }
    }

    if ($invalidUsers.Count -gt 0) {
        Write-Host "`nWarning: $($invalidUsers.Count) user(s) not found:" -ForegroundColor Yellow
        foreach ($invalidUser in $invalidUsers) {
            Write-Host "  - $invalidUser" -ForegroundColor Yellow
        }
        Write-Host ""
        $continue = 'N'
        if (-not $script:CliOptions.NonInteractive) {
            $continue = Read-Host "Continue anyway? Rows with invalid users may fail. (Y/N)"
        } else {
            Write-Host "Running unattended; not continuing past unresolved users." -ForegroundColor Red
        }
        if ($continue -ne 'Y') {
            Write-Host "Operation cancelled" -ForegroundColor Yellow
            return
        }
    } else {
        Write-Host "All users validated successfully" -ForegroundColor Green
    }

    $results = @()
    $currentIndex = 0
    $totalRows = $csv.Count

    if ($WhatIf) {
        Write-Host "`n[PREVIEW] Checking $totalRows rows..." -ForegroundColor Yellow
    } else {
        Write-Host "`nProcessing $totalRows rows..." -ForegroundColor Cyan
    }

    foreach ($row in $csv) {
        $currentIndex++
        if ($WhatIf) {
            Write-Host "`r  [PREVIEW] Checking row $currentIndex of $totalRows..." -NoNewline -ForegroundColor Yellow
        } else {
            Write-Host "`r  Processing row $currentIndex of $totalRows..." -NoNewline -ForegroundColor Gray
        }

        $processId = Get-IdFromCsvRow -Row $row
        $newOwner = Get-NewOwnerFromCsvRow -Row $row
        $newExpert = Get-NewExpertFromCsvRow -Row $row

        if (-not $processId) {
            $results += [PSCustomObject]@{
                ObjectType = "Process"
                ObjectID = "N/A"
                Operation = "UpdateOwnership"
                Status = "Skipped"
                Message = "Missing ProcessID"
                ActionUrl = ""
            }
            continue
        }

        # Get current process
        $getUrl = "$SiteURL/Api/v1/Processes/$processId"
        $process = Invoke-ApiGet -Url $getUrl -Token $Token

        if ($process) {
            if ($WhatIf) {
                # Dry-run: Show what would happen
                $processName = if ($process.name) { $process.name } else { "Unknown" }
                $currentOwner = if ($process.owner) { $process.owner } else { "None" }
                $currentExpert = if ($process.expert) { $process.expert } else { "None" }

                $changes = @()
                if ($newOwner) { $changes += "Owner: $currentOwner -> $newOwner" }
                if ($newExpert) { $changes += "Expert: $currentExpert -> $newExpert" }

                if ($changes.Count -gt 0) {
                    $results += [PSCustomObject]@{
                        ObjectType = "Process"
                        ObjectID = $processId
                        Operation = "UpdateOwnership"
                        Status = "Preview"
                        Message = "Would update '$processName' - $($changes -join ', ')"
                        ActionUrl = "$SiteURL/Process/View/$processId"
                    }
                } else {
                    $results += [PSCustomObject]@{
                        ObjectType = "Process"
                        ObjectID = $processId
                        Operation = "UpdateOwnership"
                        Status = "Skipped"
                        Message = "No updates provided"
                        ActionUrl = ""
                    }
                }
            } else {
                # Actual operation
                $updated = $false

                # Update owner if provided
                if ($newOwner) {
                    $process.owner = $newOwner
                    $updated = $true
                }

                # Update expert if provided
                if ($newExpert) {
                    $process.expert = $newExpert
                    $updated = $true
                }

                if ($updated) {
                    $updateUrl = "$SiteURL/Api/v1/Processes/$processId"
                    $updateResult = Invoke-ApiPut -Url $updateUrl -Token $Token -Body $process

                    if ($updateResult -and $updateResult.Success) {
                        $results += [PSCustomObject]@{
                            ObjectType = "Process"
                            ObjectID = $processId
                            Operation = "UpdateOwnership"
                            Status = "Success"
                            Message = "Owner: $newOwner, Expert: $newExpert"
                            ActionUrl = "$SiteURL/Process/View/$processId"
                        }
                    } else {
                        $results += [PSCustomObject]@{
                            ObjectType = "Process"
                            ObjectID = $processId
                            Operation = "UpdateOwnership"
                            Status = "Failed"
                            Message = "Update failed"
                            ActionUrl = ""
                        }
                    }
                } else {
                    $results += [PSCustomObject]@{
                        ObjectType = "Process"
                        ObjectID = $processId
                        Operation = "UpdateOwnership"
                        Status = "Skipped"
                        Message = "No updates provided"
                        ActionUrl = ""
                    }
                }
            }
        } else {
            $results += [PSCustomObject]@{
                ObjectType = "Process"
                ObjectID = $processId
                Operation = "UpdateOwnership"
                Status = "Failed"
                Message = "Process not found"
                ActionUrl = ""
            }
        }
    }
    Write-Host ""  # New line after progress counter

    # Save results
    $timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
    if ($WhatIf) {
        $outputPath = "UpdateOwnership_Preview_$timestamp.csv"
    } else {
        $outputPath = "UpdateOwnership_Results_$timestamp.csv"
    }
    $results | Export-Csv -Path $outputPath -NoTypeInformation

    Write-Host ""
    if ($WhatIf) {
        Write-Host "Preview results saved to: $outputPath" -ForegroundColor Yellow
        Write-Host "Total items checked: $($results.Count)" -ForegroundColor Cyan
        Write-Host "Would update ownership: $(($results | Where-Object {$_.Status -eq 'Preview'}).Count)" -ForegroundColor Yellow
        Write-Host "Skipped: $(($results | Where-Object {$_.Status -eq 'Skipped'}).Count)" -ForegroundColor Gray
        Write-Host "Failed to check: $(($results | Where-Object {$_.Status -eq 'Failed'}).Count)" -ForegroundColor Red
        Write-Host ""
        Write-Host "*** This was a PREVIEW - no changes were made ***" -ForegroundColor Yellow
    } else {
        Write-Host "Results saved to: $outputPath" -ForegroundColor Green
        Write-Host "Total operations: $($results.Count)" -ForegroundColor Cyan
        Write-Host "Successful: $(($results | Where-Object {$_.Status -eq 'Success'}).Count)" -ForegroundColor Green
        Write-Host "Failed: $(($results | Where-Object {$_.Status -eq 'Failed'}).Count)" -ForegroundColor Red
    }
}

# ============================================================================
# MODE 5: BULK DELETE PROCESSES
# ============================================================================
#
# All dependency discovery, reference removal and deletion live in
# NintexProcessDependencies.ps1. This section only gathers the target set and
# cleans up group folders, because those use this script's group helpers.
#
# The phase order below is dictated by measured API behaviour, not preference.
# See API_ARCHITECTURE.md "Dependency Checking APIs" for the evidence.
#
#   Gather      resolve CSV / group / archived sources to process UniqueIds
#   Hold        restore archived TARGETS, so references held against them stop
#               being suppressed from the dependency check
#   Plan        discover claims, restore archived holders in place, re-run
#               discovery until stable, scan for the API's blind spot, locate
#               every site by walking JSON, reconcile, write the plan to disk
#   Remove      one fetch, one save, one publish per HOLDER, all targets at once
#   Verify      re-walk each holder while everything is still ACTIVE; archiving
#               suppresses the rows that would reveal a miss
#   Delete      archive then delete the targets
#   Restore     re-archive whatever the run restored, to its ORIGINAL group
#   Cleanup     remove the holding group, optionally the source group folders
#
# The plan file is the crash-safety net: it is written before the first
# mutation and updated after each re-archive, so an interrupted run can be
# finished from it rather than leaving processes stranded in the wrong state.
# ============================================================================

function Archive-Process {
    param(
        [string]$SiteURL,
        [string]$Token,
        [string]$ProcessUniqueId,
        [string]$Comment = "Bulk operation"
    )

    try {
        # Step 1: Archive the process using the correct API format
        $archiveUrl = "$SiteURL/Process/Edit/ArchiveProcess"
        $archiveBody = @{
            processUniqueId = $ProcessUniqueId
            comment = $Comment
        }

        $archiveResult = Invoke-ApiPost -Url $archiveUrl -Token $Token -Body $archiveBody

        if (-not $archiveResult) {
            return $false
        }

        # Step 2: Check if we need to bypass approval
        # After archiving, the process might be in a pending approval state
        # We need to call the Publish endpoint to complete the archive

        # Get the current process data to get ProcessRevisionEditId
        $getUrl = "$SiteURL/Api/v1/Processes/$ProcessUniqueId"
        $processData = Invoke-ApiGet -Url $getUrl -Token $Token

        if ($processData -and $processData.processJson -and $processData.processJson.ProcessRevisionEditId) {
            $processRevisionEditId = $processData.processJson.ProcessRevisionEditId

            # Call the publish/approval bypass endpoint
            $publishUrl = "$SiteURL/Api/v1/Processes/$ProcessUniqueId/Publish"
            $publishBody = @{
                ProcessRevisionEditId = $processRevisionEditId
                IsPublishNow = $true
            }

            Invoke-ApiPost -Url $publishUrl -Token $Token -Body $publishBody | Out-Null
        }

        return $true
    }
    catch {
        Write-Host "  Archive error: $($_.Exception.Message)" -ForegroundColor Red
        return $false
    }
}

# Returns an array of dependency types found (e.g., @("Linked Process", "Process Input", "Process Output"))
# Legacy function for backwards compatibility - returns boolean
function Get-AllArchivedProcesses {
    # UniqueIds only. Shares Get-ArchivedProcessItems with Get-ArchivedProcesses
    # so both read the archive at the same page size.
    param(
        [string]$SiteURL,
        [string]$Token
    )

    Write-Host "  Fetching all archived processes from site..." -ForegroundColor Gray

    try {
        $items = @(Get-ArchivedProcessItems -SiteURL $SiteURL -Token $Token)
    }
    catch {
        Write-Host "  Error fetching archived processes: $($_.Exception.Message)" -ForegroundColor Red
        return @()
    }

    $allArchivedProcesses = @($items | ForEach-Object { $_.processUniqueId } | Where-Object { $_ })

    Write-Host "  Total archived processes found: $($allArchivedProcesses.Count)" -ForegroundColor Green
    return $allArchivedProcesses
}

function Get-AllArchivedDocuments {
    param(
        [string]$SiteURL,
        [string]$Token
    )

    Write-Host "  Fetching all archived documents from site..." -ForegroundColor Gray

    $allArchivedDocuments = @()
    $page = 1
    $pageSize = 20
    $hasMore = $true

    # Fetch all archived documents with pagination
    while ($hasMore) {
        try {
            # ListType=Archived for archived documents
            $listUrl = "$SiteURL/bff/document/api/v1/documents?Page=$page&PageSize=$pageSize&ListType=Archived&DocumentType=All"
            $response = Invoke-ApiGet -Url $listUrl -Token $Token

            if ($response -and $response.items -and $response.items.Count -gt 0) {
                Write-Host "  Page $page : Found $($response.items.Count) archived documents" -ForegroundColor Gray

                # Add each document to the list with both ID and name for display
                foreach ($item in $response.items) {
                    $allArchivedDocuments += @{
                        DocumentId = $item.documentId
                        DocumentUniqueId = $item.documentUniqueId
                        DocumentName = $item.documentName
                        PrimaryGroupName = $item.primaryGroupName
                        ArchivedDate = $item.archivedDate
                        ArchivedByUserName = $item.archivedByUserName
                    }
                }

                # Check if there are more pages
                if ($response.items.Count -lt $pageSize) {
                    $hasMore = $false
                } else {
                    $page++
                }
            } else {
                $hasMore = $false
            }
        }
        catch {
            Write-Host "  Error fetching archived documents: $($_.Exception.Message)" -ForegroundColor Red
            $hasMore = $false
        }
    }

    Write-Host "  Total archived documents found: $($allArchivedDocuments.Count)" -ForegroundColor Green
    return $allArchivedDocuments
}

function Delete-ArchivedDocuments {
    param(
        [string]$SiteURL,
        [string]$Token,
        [array]$DocumentIds
    )

    if ($DocumentIds.Count -eq 0) {
        Write-Host "  No documents to delete" -ForegroundColor Yellow
        return @{ Success = $true; Deleted = 0; Failed = 0 }
    }

    $deleted = 0
    $failed = 0
    $batchSize = 50  # Delete in batches of 50

    # Process in batches
    for ($i = 0; $i -lt $DocumentIds.Count; $i += $batchSize) {
        $batch = $DocumentIds[$i..([Math]::Min($i + $batchSize - 1, $DocumentIds.Count - 1))]

        try {
            $deleteUrl = "$SiteURL/bff/document/api/v1/documents/bulk"
            $deleteBody = @{
                documentIds = $batch
            }

            $headers = @{
                "Authorization" = "Bearer $Token"
                "Content-Type" = "application/json"
                "Accept" = "application/json"
                "X-Requested-With" = "XMLHttpRequest"
            }

            $jsonBody = $deleteBody | ConvertTo-Json -Depth 10
            $response = Invoke-RestMethod -Uri $deleteUrl -Method Delete -Headers $headers -Body $jsonBody -ErrorAction Stop

            $deleted += $batch.Count
            Write-Host "`r  Deleted $deleted of $($DocumentIds.Count) documents..." -NoNewline -ForegroundColor Gray
        }
        catch {
            $failed += $batch.Count
            Write-Host "`n  Error deleting batch: $($_.Exception.Message)" -ForegroundColor Red
        }

        # Small delay between batches
        Start-Sleep -Milliseconds 200
    }

    Write-Host ""  # New line after progress
    return @{ Success = ($failed -eq 0); Deleted = $deleted; Failed = $failed }
}

# Object-based version that works directly with PSObjects (avoids double serialization)
# Object-based version that works directly with PSObjects (avoids double serialization)
function Resolve-CollateralName {
    # One name per process, whoever is reporting it. The holding-group listing
    # returns the master's name for a variation (the " :: Premium" suffix is
    # dropped), so two producers could print one id under two names.
    param($NameLookup, [string]$UniqueId, [string]$Fallback = '')

    if ($null -ne $NameLookup -and $UniqueId) {
        $key = $UniqueId.ToLowerInvariant()
        if ($NameLookup.ContainsKey($key) -and $NameLookup[$key].Name) {
            return [string]$NameLookup[$key].Name
        }
    }
    if ($Fallback) { return $Fallback }
    return $UniqueId
}

function Remove-HoldingGroup {
    <#
    .SYNOPSIS
        Deletes the temporary holding group, but never while it still holds
        processes.

    .DESCRIPTION
        The group exists only to park archived targets while their references
        are removed. By cleanup time every target should have been deleted or
        re-archived back to its own group, so a non-empty holding group means
        something did not finish.

        Deleting it anyway is how processes get lost: they are live, they are in
        a group nobody will look in again, and the plan that named the group is
        the only record. So it is left in place and named.
    #>
    param(
        [string]$SiteURL,
        [string]$Token,
        $TempGroup,
        [string]$GroupName,
        [string[]]$TargetUniqueIds = @(),
        [string[]]$ReportedUniqueIds = @(),
        $NameLookup = $null
    )

    $results = @()
    if (-not $TempGroup) { return $results }

    $remaining = @()
    try {
        $remaining = @(Get-ProcessesFromGroup -SiteURL $SiteURL -Token $Token `
            -GroupID $TempGroup.id -GroupUniqueId $TempGroup.uniqueId -IncludeSubgroups $false)
    } catch {
        Write-Host "  Could not read the holding group's contents: $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host "  Leaving '$GroupName' in place rather than deleting a group of unknown contents." -ForegroundColor Yellow
        return @([PSCustomObject]@{
            ObjectType = 'ProcessGroup'; ObjectID = $TempGroup.uniqueId; Name = $GroupName
            Operation = 'Cleanup'; Status = 'Skipped'
            Message = 'Could not verify the group is empty; delete it manually after checking'
        })
    }

    if ($remaining.Count -gt 0) {
        Write-Host "  '$GroupName' still holds $($remaining.Count) process(es). NOT deleting it." -ForegroundColor Red
        foreach ($proc in $remaining) {
            $name = if ($proc.processName) { $proc.processName } else { $proc.processUniqueId }
            Write-Host "      $name ($($proc.processUniqueId))" -ForegroundColor Red
        }
        Write-Host "  These are live processes. Move or archive them before deleting the group." -ForegroundColor Red

        $results += [PSCustomObject]@{
            ObjectType = 'ProcessGroup'; ObjectID = $TempGroup.uniqueId; Name = $GroupName
            Operation = 'Cleanup'; Status = 'Skipped'
            Message = "Still holds $($remaining.Count) process(es): $(@($remaining | ForEach-Object { $_.processUniqueId }) -join ', ')"
        }

        # A process stranded in the holding group was moved there by this run and
        # left behind, which makes it collateral whatever the list sweeps said.
        # It used to be mentioned only in the group-deletion message, which is
        # not where anyone looks for damage.
        #
        # The checkpoints are the other producer of collateral rows, so anything
        # they already reported is skipped here. Emitting both gave 7 rows for 5
        # processes.
        $alreadyReported = @{}
        foreach ($id in @($ReportedUniqueIds)) {
            if ($id) { $alreadyReported[([string]$id).ToLowerInvariant()] = $true }
        }

        foreach ($proc in $remaining) {
            $procId = [string]$proc.processUniqueId
            if (-not $procId) { continue }
            $key = $procId.ToLowerInvariant()

            $isTarget = $false
            foreach ($t in @($TargetUniqueIds)) {
                if ($t -and $t.ToLowerInvariant() -eq $key) { $isTarget = $true }
            }
            if ($isTarget) { continue }
            if ($alreadyReported.ContainsKey($key)) { continue }

            # The group listing drops the variation suffix and shows the master's
            # name, so the same id could print under two different names across
            # the two producers. The index name wins: it is what the rest of the
            # run calls this process.
            $name = Resolve-CollateralName -NameLookup $NameLookup -UniqueId $procId `
                -Fallback ([string]$proc.processName)

            $results += [PSCustomObject]@{
                ObjectType = 'Process'; ObjectID = $procId; Name = $name
                Operation = 'Collateral'; Status = 'Failed'
                Message = "Left stranded in the holding group '$GroupName' and was not a target; move it back manually"
            }
        }

        return $results
    }

    $ok = Delete-ProcessGroup -SiteURL $SiteURL -Token $Token -GroupUniqueId $TempGroup.uniqueId
    if (-not $ok) {
        Write-Host "  Could not delete the holding group '$GroupName'. Delete it manually." -ForegroundColor Yellow
    }

    return @([PSCustomObject]@{
        ObjectType = 'ProcessGroup'; ObjectID = $TempGroup.uniqueId; Name = $GroupName
        Operation = 'Cleanup'
        Status = $(if ($ok) { 'Success' } else { 'Failed' })
        Message = $(if ($ok) { 'Empty holding group deleted' } else { 'Delete failed; remove it manually' })
    })
}

function Invoke-BulkDeleteProcesses {
    <#
    .SYNOPSIS
        Mode 5. Removes every reference to the target processes, then deletes them.

    .DESCRIPTION
        Thin orchestrator over NintexProcessDependencies.ps1. Gathering the target
        set and cleaning up group folders stay here because they use this script's
        group helpers; everything about dependencies lives in the engine.

        The phase order is dictated by measured API behaviour, not preference.
        See API_ARCHITECTURE.md "Dependency Checking APIs".
    #>
    param(
        [string]$SiteURL,
        [string]$Token,
        [string]$SourceType,  # "CSV", "Group", or "Archived"
        [string]$CsvPath = "",
        [int]$GroupID = -1,
        [string]$GroupUniqueId = "",
        [string]$TempGroupName = "Bulk Delete Temporary Group",
        [string]$CurrentUsername,
        [switch]$WhatIf,
        [switch]$Force,
        [switch]$ApprovalsEnabled,
        [switch]$ThoroughScan,
        [switch]$IncludeSubgroups,
        [switch]$AllowUnheldTargets
    )

    Write-Host "`n========================================" -ForegroundColor Cyan
    if ($WhatIf) {
        Write-Host "BULK DELETE PROCESSES (DRY-RUN PREVIEW)" -ForegroundColor Yellow
        Write-Host "========================================" -ForegroundColor Cyan
        Write-Host "*** PREVIEW MODE: No changes will be made ***" -ForegroundColor Yellow
        Write-Host "Preview cannot restore archived processes, so it understates the work." -ForegroundColor Yellow
    } else {
        Write-Host "BULK DELETE PROCESSES" -ForegroundColor Cyan
        Write-Host "========================================" -ForegroundColor Cyan
        Write-Host "WARNING: This is a destructive operation." -ForegroundColor Red
    }

    $approvalsEnabled = [bool]$ApprovalsEnabled
    $scanActive = [bool]$ThoroughScan

    if (-not $WhatIf -and -not $Force) {
        $approvalsEnabled = (Read-Host "Are process approvals enabled in your environment? (Y/N)") -eq 'Y'

        Write-Host "`nInput and Output references can be invisible to the dependency API." -ForegroundColor Yellow
        Write-Host "A thorough scan reads every active process (slow: one call each, 700+ on a" -ForegroundColor Yellow
        Write-Host "large tenant) and is the only way to be certain none are missed." -ForegroundColor Yellow
        $scanActive = (Read-Host "Run the thorough scan? (Y/N)") -eq 'Y'

        if ((Read-Host "`nType 'DELETE' to confirm you want to proceed") -ne 'DELETE') {
            Write-Host "Operation cancelled" -ForegroundColor Yellow
            return
        }
    }
    elseif ($Force -and -not $WhatIf) {
        Write-Host "`n-Force supplied: running unattended, no confirmation prompts." -ForegroundColor Yellow
        Write-Host "  Approvals enabled : $approvalsEnabled" -ForegroundColor Yellow
        Write-Host "  Thorough scan     : $scanActive" -ForegroundColor Yellow
    }

    $results = @()

    # Everything any checkpoint flagged, gathered so the manual-attention list
    # can be re-checked against the tenant at the moment the run ends rather
    # than against a diff taken before the unwind.
    $runCollateral = @()

    # The Hold phase logs to a preliminary plan, and the real plan is later
    # written over the same path. Without carrying these forward the finished
    # plan file loses exactly the lines worth keeping: which targets could not be
    # held, and whether an unchecked delete was authorised.
    $holdLog = @()

    # What to do when a target's dependency check still fails after a retry.
    # A single transient 500 on a 497-item batch should not discard twenty
    # minutes of discovery, but proceeding is always an explicit decision: the
    # default, and the only answer available unattended, is to stop.
    $failedTargetDecision = {
        param($Failed)

        if ($WhatIf) { return $false }
        if ($Force) {
            Write-Host "  -Force: not proceeding past failed dependency checks. Fix them and re-run." -ForegroundColor Red
            return $false
        }

        Write-Host "`n$(@($Failed).Count) target(s) could not be checked for dependencies." -ForegroundColor Red
        Write-Host "Proceeding excludes them from the run; the rest checked cleanly." -ForegroundColor Yellow
        return ((Read-Host "Proceed with the targets that checked cleanly? (Y/N)") -eq 'Y')
    }

    # ---- Gather the target set -------------------------------------------
    Write-Host "`n=== GATHERING TARGETS ===" -ForegroundColor Cyan
    $rawIds = @()

    if ($SourceType -eq "CSV") {
        $csv = Read-CsvWithFlexibleHeaders -Path $CsvPath
        if (-not $csv) { return }
        foreach ($row in $csv) {
            $id = Get-IdFromCsvRow -Row $row
            if ($id) { $rawIds += $id }
        }
    }
    elseif ($SourceType -eq "Archived") {
        Write-Host "Fetching all archived processes..." -ForegroundColor Yellow
        $rawIds = @(Get-AllArchivedProcesses -SiteURL $SiteURL -Token $Token)
    }
    else {
        $includeSubgroups = [bool]$IncludeSubgroups
        if (-not $Force -and -not $WhatIf) {
            $includeSubgroups = (Read-Host "Include subgroups? (Y/N)") -eq 'Y'
        }
        $processes = Get-ProcessesFromGroup -SiteURL $SiteURL -Token $Token `
            -GroupID $GroupID -GroupUniqueId $GroupUniqueId -IncludeSubgroups $includeSubgroups
        $rawIds = @($processes | ForEach-Object { $_.processUniqueId })
    }

    if ($rawIds.Count -eq 0) {
        Write-Host "No processes to delete" -ForegroundColor Yellow
        return
    }

    # ---- Resolve to UniqueIds via a single index sweep --------------------
    Write-Host "Indexing tenant processes..." -ForegroundColor Gray
    $index = Get-NpmProcessIndex -SiteURL $SiteURL -Token $Token

    $numericLookup = @{}
    foreach ($entry in $index.Values) {
        if ($null -ne $entry.NumericId) { $numericLookup["$($entry.NumericId)"] = $entry.UniqueId }
    }

    $targetUniqueIds = @()
    $unresolved = @()
    foreach ($raw in $rawIds) {
        $id = [string]$raw
        if (Get-NpmIndexEntry -Index $index -UniqueId $id) {
            $targetUniqueIds += $id
        } elseif ($numericLookup.ContainsKey($id)) {
            $targetUniqueIds += $numericLookup[$id]
        } else {
            $unresolved += $id
            $results += [PSCustomObject]@{
                ObjectType = 'Process'; ObjectID = $id; Name = ''
                Operation = 'Resolve'; Status = 'Failed'; Message = 'Process not found in active or archived lists'
            }
        }
    }
    $targetUniqueIds = @($targetUniqueIds | Select-Object -Unique)

    if ($unresolved.Count -gt 0) {
        Write-Host "  $($unresolved.Count) id(s) could not be resolved and will be skipped" -ForegroundColor Yellow
    }
    if ($targetUniqueIds.Count -eq 0) {
        Write-Host "No resolvable processes to delete" -ForegroundColor Yellow
        return
    }
    Write-Host "  $($targetUniqueIds.Count) target process(es)" -ForegroundColor Green

    # ---- Snapshot original state BEFORE anything moves --------------------
    # Everything the unwind path needs (was it archived, which group did it come
    # from) has to be read now. The Hold phase below un-archives the archived
    # targets and moves them into a temporary group, and every index read after
    # that reports where they were put, not where they came from.
    $timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
    $planPath = "Delete_Plan_$timestamp.json"

    Write-Host "`n=== SNAPSHOT ===" -ForegroundColor Cyan
    Write-Host "Recording the original state of $($targetUniqueIds.Count) target(s) before any change." -ForegroundColor Gray

    # Numeric groupId to group UniqueId, so the ledger can name the home group
    # in the form deletion and restore actually use.
    $groupUniqueIdMap = @{}
    try {
        foreach ($g in @(Get-ProcessGroups -SiteURL $SiteURL -Token $Token)) {
            if ($null -ne $g.id) { $groupUniqueIdMap["$($g.id)"] = $g.uniqueId }
        }
    } catch {
        Write-Host "  Could not map group ids to unique ids: $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host "  The plan will still record numeric group ids." -ForegroundColor Yellow
    }

    $snapshot = New-ProcessStateSnapshot -Index $index -UniqueIds $targetUniqueIds -GroupUniqueIdMap $groupUniqueIdMap

    # The whole tenant, not just the targets. A process variation is stored as
    # its own record and acting on one acts on its master, with nothing in the
    # model or the list entry to warn you. Comparing the tenant before and after
    # each mutating phase is the only way to see it happen.
    $tenantBaseline = New-TenantStateSnapshot -Index $index
    Write-Host "  Baseline covers the $($tenantBaseline.Count) process(es) the active and archived" -ForegroundColor Gray
    Write-Host "  list sweeps return. Those sweeps are NOT complete: processes exist that" -ForegroundColor Gray
    Write-Host "  neither returns, and this run cannot know the prior state of one of those." -ForegroundColor Gray

    # What to do when a phase changes something it was not asked to change.
    # Stopping is the default and the only answer available unattended: the
    # run has just proved it affects processes nobody listed, so it has no
    # business continuing to an irreversible delete without a human.
    $collateralDecision = {
        param($Collateral)

        if ($Force) {
            Write-Host "`n-Force cannot approve collateral changes. Stopping." -ForegroundColor Red
            Write-Host "Re-run interactively, or add the affected processes to the target set if" -ForegroundColor Yellow
            Write-Host "they really should be included." -ForegroundColor Yellow
            return $false
        }

        Write-Host "`n$(@($Collateral).Count) process(es) changed that were not targets." -ForegroundColor Red
        return ((Read-Host "Continue anyway? Type 'YES' to accept these changes") -eq 'YES')
    }

    # ---- Pre-flight: targets that look like variations ---------------------
    # The checkpoints report damage. This is the only thing that can prevent it,
    # because it runs before the first mutation. It is a name heuristic and says
    # so; see Find-VariationMaster.
    $variationMatches = @(Find-VariationMaster -Index $index -TargetUniqueIds $targetUniqueIds)

    if ($variationMatches.Count -gt 0) {
        Show-VariationWarning -Matches $variationMatches

        $proceedVariation = $false
        if ($Force) {
            Write-Host "`n-Force will not proceed past a variation warning. Stopping." -ForegroundColor Red
            Write-Host "Add the masters to the target set if they should be deleted too, or re-run" -ForegroundColor Yellow
            Write-Host "interactively to decide case by case." -ForegroundColor Yellow
        } elseif ($WhatIf) {
            # A preview changes nothing, so there is nothing to protect it from.
            Write-Host "`nPreview only; continuing so the plan can be inspected." -ForegroundColor Yellow
            $proceedVariation = $true
        } else {
            $proceedVariation = ((Read-Host "`nContinue anyway? Type 'YES' to accept the risk to these masters") -eq 'YES')
        }

        if (-not $proceedVariation) {
            Write-Host "Operation cancelled. Nothing has been changed." -ForegroundColor Yellow
            foreach ($m in $variationMatches) {
                $results += [PSCustomObject]@{
                    ObjectType = 'Process'; ObjectID = $m.MasterUniqueId; Name = $m.MasterName
                    Operation = 'VariationWarning'; Status = 'Failed'
                    Message = "Master of target '$($m.TargetName)' and not itself a target; run stopped before any change"
                }
            }
            $results = @(Resolve-CollateralOutcome -SiteURL $SiteURL -Token $Token -Collateral $runCollateral -Results $results)
                Save-DeleteResults -Results $results -Timestamp $timestamp
            return
        }
    }

    # ---- Pre-flight: targets whose group is gone ---------------------------
    # An operator wants this before the run, not in the results file after it.
    # These targets can be held and deleted normally, but a run that stops short
    # of deletion cannot put them back where they came from, because where they
    # came from does not exist any more.
    #
    # This covers targets only. A dependency holder in the same state is not
    # knowable until the dependency scan has run, and blocks the plan there.
    $orphanTargets = @(Find-OrphanedGroupProcess -Index $index -UniqueIds $targetUniqueIds)
    if ($orphanTargets.Count -gt 0) {
        Show-OrphanedGroupWarning -Orphans $orphanTargets -TotalTargets $targetUniqueIds.Count `
            -HoldingGroupName $TempGroupName
    }

    # ---- Holding group ----------------------------------------------------
    # Only archived TARGETS go here. Dependency holders are restored in place to
    # their own group, because they survive the run and parking them elsewhere
    # would strand them there.
    $tempGroup = $null
    $archivedTargets = @($targetUniqueIds | Where-Object {
        $e = Get-NpmIndexEntry -Index $index -UniqueId $_
        $null -ne $e -and $e.IsArchived
    })

    if (-not $WhatIf -and $archivedTargets.Count -gt 0) {
        Write-Host "`n=== HOLDING GROUP ===" -ForegroundColor Cyan
        Write-Host "$($archivedTargets.Count) target(s) are archived. Restoring them so that references" -ForegroundColor Yellow
        Write-Host "held against them become visible to the dependency check." -ForegroundColor Yellow

        $tempGroup = New-ProcessGroup -SiteURL $SiteURL -Token $Token -GroupName $TempGroupName
        if (-not $tempGroup) {
            Write-Host "Could not create the holding group. Cannot proceed safely." -ForegroundColor Red
            return
        }

        # The crash-safety net has to exist before the first mutation, not after
        # it. This preliminary plan carries the pre-Hold ledger and the temp
        # group, which is enough to unwind by hand if the run dies mid-restore.
        $preliminary = New-DependencyPlan -SiteURL $SiteURL -TargetUniqueIds $targetUniqueIds
        $preliminary.Status = 'Holding'
        $preliminary.Ledger = @(ConvertTo-PlanLedgerEntry -Snapshot $snapshot)
        $holdLog += "Holding group '$TempGroupName' created: id $($tempGroup.id), uniqueId $($tempGroup.uniqueId)"
        $holdLog += "About to restore $($archivedTargets.Count) archived target(s) into the holding group"
        $preliminary.Log = @($holdLog)
        [void](Export-DependencyPlan -Plan $preliminary -Path $planPath)
        Write-Host "Pre-mutation plan written to: $planPath" -ForegroundColor Green

        $held = 0
        $failedHolds = @()

        foreach ($target in $archivedTargets) {
            $held++
            Write-NpmProgress -Activity 'Holding group' -Status 'Restoring archived targets' `
                -Done $held -Total $archivedTargets.Count -Id 3

            if (Restore-NpmProcess -SiteURL $SiteURL -Token $Token -ProcessUniqueId $target -ProcessGroupId $tempGroup.id) {
                # Recorded per target as it happens, so an interrupted Hold phase
                # leaves a plan that names exactly what was moved.
                Set-ProcessSnapshotRestored -Snapshot $snapshot -UniqueId $target -HoldingGroupId $tempGroup.id
            } else {
                $failedHolds += $target
                $holdLog += "FAILED to restore target $target into the holding group"
                $results += [PSCustomObject]@{
                    ObjectType = 'Process'; ObjectID = $target; Name = ''
                    Operation = 'Hold'; Status = 'Failed'; Message = 'Could not restore into the holding group'
                }
            }
            $preliminary.Ledger = @(ConvertTo-PlanLedgerEntry -Snapshot $snapshot)
            $preliminary.Log = @($holdLog)
            [void](Export-DependencyPlan -Plan $preliminary -Path $planPath)
        }
        Complete-NpmProgress -Activity 'Holding group' -Id 3

        # ---- A target that never came out of the archive was never checked ---
        # The Hold phase exists for one reason: archiving hides Input and Output
        # rows, so a reference held against an archived target is invisible until
        # the target is active. A target whose restore failed stayed archived, so
        # its Input/Output edges were never visible to the dependency check. The
        # run already logged exactly that, and then deleted it anyway.
        #
        # Deleting it can leave a dangling Input on a surviving process, which is
        # the one failure this whole engine exists to prevent. So it comes out of
        # the delete set and the rest of the batch carries on.
        if ($failedHolds.Count -gt 0) {
            Write-Host "`n=== TARGETS THAT COULD NOT BE HELD ===" -ForegroundColor Red
            Write-Host "$($failedHolds.Count) target(s) could not be restored out of the archive." -ForegroundColor Red
            Write-Host "Their Input and Output references were never visible to the dependency check." -ForegroundColor Red

            foreach ($failed in $failedHolds) {
                $fentry = Get-NpmIndexEntry -Index $index -UniqueId $failed
                $fname = if ($fentry -and $fentry.Name) { $fentry.Name } else { $failed }
                Write-Host "  $fname  ($failed)" -ForegroundColor Red
            }

            if ($AllowUnheldTargets) {
                Write-Host "`n-AllowUnheldTargets was supplied. These stay in the delete set and will be" -ForegroundColor Red
                Write-Host "deleted WITHOUT their references ever having been checked." -ForegroundColor Red
                foreach ($failed in $failedHolds) {
                    $holdLog += "UNCHECKED DELETE allowed by -AllowUnheldTargets: $failed"
                }
            }
            else {
                Write-Host "`nExcluding them from this run. Everything else continues." -ForegroundColor Yellow
                Write-Host "Re-run them once the tenant will restore them, or pass -AllowUnheldTargets to" -ForegroundColor Yellow
                Write-Host "delete them unchecked, which risks leaving dangling references behind." -ForegroundColor Yellow

                $excludedHold = @{}
                foreach ($failed in $failedHolds) { $excludedHold[$failed.ToLowerInvariant()] = $true }

                foreach ($failed in $failedHolds) {
                    $fentry = Get-NpmIndexEntry -Index $index -UniqueId $failed
                    $fname = if ($fentry -and $fentry.Name) { $fentry.Name } else { '' }
                    $results += [PSCustomObject]@{
                        ObjectType = 'Process'; ObjectID = $failed; Name = $fname
                        Operation = 'Delete'; Status = 'Skipped'
                        Message = 'NOT deleted: could not be restored out of the archive, so its Input/Output references were never checked'
                    }
                    $holdLog += "Excluded $failed from the delete set: Hold failed, references unchecked"
                }

                $targetUniqueIds = @($targetUniqueIds | Where-Object { -not $excludedHold.ContainsKey($_.ToLowerInvariant()) })
                $archivedTargets = @($archivedTargets | Where-Object { -not $excludedHold.ContainsKey($_.ToLowerInvariant()) })

                if ($targetUniqueIds.Count -eq 0) {
                    Write-Host "`nNo targets remain. Nothing will be deleted." -ForegroundColor Yellow
                    $preliminary.Status = 'AbortedNoHeldTargets'
                    $preliminary.Log = @($holdLog)
                    [void](Export-DependencyPlan -Plan $preliminary -Path $planPath)
                    $results += @(Remove-HoldingGroup -SiteURL $SiteURL -Token $Token -TempGroup $tempGroup `
                        -GroupName $TempGroupName -TargetUniqueIds $targetUniqueIds -NameLookup $tenantBaseline)
                    $results = @(Resolve-CollateralOutcome -SiteURL $SiteURL -Token $Token -Collateral $runCollateral -Results $results)
                Save-DeleteResults -Results $results -Timestamp $timestamp
                    return
                }
            }
        }
        Write-Host "  Held $($archivedTargets.Count) target(s) in '$TempGroupName'" -ForegroundColor Gray

        $index = Get-NpmProcessIndex -SiteURL $SiteURL -Token $Token

        # ---- Collateral check, straight after the first mutating phase ----
        Write-Host "`n=== CHECKING FOR COLLATERAL CHANGES ===" -ForegroundColor Cyan
        $heldNow = @()
        try {
            $heldNow = @(Get-ProcessesFromGroup -SiteURL $SiteURL -Token $Token `
                -GroupID $tempGroup.id -GroupUniqueId $tempGroup.uniqueId -IncludeSubgroups $false |
                ForEach-Object { $_.processUniqueId } | Where-Object { $_ })
        } catch { }

        $holdCollateral = @(Compare-TenantState -Baseline $tenantBaseline -Index $index `
            -ExpectedUniqueIds $targetUniqueIds -ObservedUniqueIds $heldNow)

        $runCollateral += @($holdCollateral)

        if ($holdCollateral.Count -gt 0) {
            Show-CollateralDamage -Collateral $holdCollateral -Phase 'after holding archived targets'

            $accept = & $collateralDecision $holdCollateral
            if (-not $accept) {
                Write-Host "`nStopping. Nothing has been deleted." -ForegroundColor Red

                $aborted = New-DependencyPlan -SiteURL $SiteURL -TargetUniqueIds $targetUniqueIds
                $aborted.Status = 'AbortedCollateral'
                $aborted.Ledger = @(ConvertTo-PlanLedgerEntry -Snapshot $snapshot)
                $aborted.Collateral = @($holdCollateral)
                foreach ($c in $holdCollateral) {
                    $aborted.Log += "COLLATERAL after hold phase: $($c.UniqueId) ($($c.Name)) - $($c.Change)"
                }
                [void](Export-DependencyPlan -Plan $aborted -Path $planPath)

                foreach ($c in $holdCollateral) {
                    $results += [PSCustomObject]@{
                        ObjectType = 'Process'; ObjectID = $c.UniqueId
                        Name = $(if ($c.Name) { $c.Name } else { $c.UniqueId })
                        Operation = 'Collateral'; Status = 'Failed'
                        Message = "Changed without being a target ($($c.Change)); run stopped"
                    }
                }

                # Put back what the run moved, its own targets first and then the
                # processes it was never asked to touch.
                $results += @(Restore-ProcessPlanState -SiteURL $SiteURL -Token $Token -Plan $aborted -PlanPath $planPath -ApprovalsEnabled $approvalsEnabled)
                $results += @(Restore-CollateralState -SiteURL $SiteURL -Token $Token -Collateral $holdCollateral -ApprovalsEnabled $approvalsEnabled)
                $results += @(Remove-HoldingGroup -SiteURL $SiteURL -Token $Token -TempGroup $tempGroup `
                    -GroupName $TempGroupName -TargetUniqueIds $targetUniqueIds `
                    -ReportedUniqueIds @(@($aborted.Collateral) | ForEach-Object { $_.UniqueId }) `
                    -NameLookup $tenantBaseline)

                $results = @(Resolve-CollateralOutcome -SiteURL $SiteURL -Token $Token -Collateral $runCollateral -Results $results)
                Save-DeleteResults -Results $results -Timestamp $timestamp
                return
            }
        } else {
            Write-Host "  No collateral changes. Only the targets moved." -ForegroundColor Green
        }
    }

    # ---- Plan -------------------------------------------------------------
    Write-Host "`n=== BUILDING PLAN ===" -ForegroundColor Cyan
    $holdingGroupId = $null
    if ($tempGroup) { $holdingGroupId = $tempGroup.id }

    # Planning is read-only, so process models can be cached across its phases.
    # Every write path evicts, and the cache is dropped before execution begins.
    Enable-NpmModelCache
    try {
        $plan = New-ProcessDeletePlan -SiteURL $SiteURL -Token $Token `
            -TargetUniqueIds $targetUniqueIds -Index $index `
            -HoldingGroupId $holdingGroupId -AllowRestore (-not $WhatIf) `
            -ScanActiveForInputOutput $scanActive `
            -PreHoldSnapshot $snapshot `
            -OnFailedTargets $failedTargetDecision
    }
    finally {
        # Zero is a normal result, not a fault. The cache exists for the two
        # cases where a process really is read twice: an archived dependency
        # holder fetched for the ledger and read again by the blind-spot sweep,
        # and a holder the sweep discovers and then adds to the ledger. A run
        # whose targets have no dependencies hits neither, and reports zero.
        $hits = Get-NpmModelCacheHitCount
        if ($hits -gt 0) {
            Write-Host "  Model cache served $hits repeat read(s)" -ForegroundColor Gray
        }
        Disable-NpmModelCache
    }

    # Carry the Hold-phase history into the plan that gets written over the same
    # path, so the finished file is the whole story rather than the last chapter.
    if ($holdLog.Count -gt 0) { $plan.Log = @($holdLog) + @($plan.Log) }

    if ($plan.Status -eq 'Blocked') {
        Write-Host "`nPlanning was blocked. Nothing has been deleted." -ForegroundColor Red
        foreach ($line in @($plan.Log)) { Write-Host "  $line" -ForegroundColor Red }

        # Anything the Hold phase pulled out of the archive has to go back, or
        # the tenant is left with live copies of processes that were archived.
        if ($tempGroup) {
            $plan.Ledger = @(ConvertTo-PlanLedgerEntry -Snapshot $snapshot)
            [void](Export-DependencyPlan -Plan $plan -Path $planPath)
            $results += @(Restore-ProcessPlanState -SiteURL $SiteURL -Token $Token -Plan $plan -PlanPath $planPath -ApprovalsEnabled $approvalsEnabled)
            $results += @(Remove-HoldingGroup -SiteURL $SiteURL -Token $Token -TempGroup $tempGroup `
                -GroupName $TempGroupName -TargetUniqueIds $targetUniqueIds `
                -ReportedUniqueIds @(@($plan.Collateral) | ForEach-Object { $_.UniqueId }) `
                -NameLookup $tenantBaseline)
            $results = @(Resolve-CollateralOutcome -SiteURL $SiteURL -Token $Token -Collateral $runCollateral -Results $results)
                Save-DeleteResults -Results $results -Timestamp $timestamp
        }
        return
    }

    # Targets excluded by a failed dependency check are named in the results CSV
    # rather than disappearing quietly.
    foreach ($failed in @($plan.FailedTargets)) {
        $results += [PSCustomObject]@{
            ObjectType = 'Process'; ObjectID = $failed.UniqueId; Name = ''
            Operation = 'DependencyCheck'; Status = 'Failed'
            Message = "Excluded from the run: HTTP $($failed.Status) $($failed.Error)"
        }
    }
    $targetUniqueIds = @($plan.TargetUniqueIds)

    [void](Export-DependencyPlan -Plan $plan -Path $planPath)
    Write-Host "Plan written to: $planPath" -ForegroundColor Green

    Show-ProcessDeletePlan -Plan $plan -Index $index

    if ($WhatIf) {
        Write-Host "`n*** PREVIEW ONLY - nothing was changed ***" -ForegroundColor Yellow
        return
    }

    # ---- Unresolved participants ------------------------------------------
    # A participant the run could not fetch is a participant whose references
    # were never examined. Deleting a target it points at leaves a broken
    # reference behind, which is the exact failure the whole dependency engine
    # exists to prevent.
    $unresolved = @($plan.Unresolved)
    if ($unresolved.Count -gt 0) {
        Write-Host "`n$($unresolved.Count) participant(s) could not be resolved." -ForegroundColor Red
        $continue = $false
        if (-not $Force) { $continue = ((Read-Host "Continue anyway? (Y/N)") -eq 'Y') }
        else { Write-Host "-Force does not wave through unresolved participants. Stopping." -ForegroundColor Red }

        if (-not $continue) {
            Write-Host "Operation cancelled. Nothing has been deleted." -ForegroundColor Yellow
            $results += @(Restore-ProcessPlanState -SiteURL $SiteURL -Token $Token -Plan $plan -PlanPath $planPath -ApprovalsEnabled $approvalsEnabled)
            if ($tempGroup) { $results += @(Remove-HoldingGroup -SiteURL $SiteURL -Token $Token -TempGroup $tempGroup -GroupName $TempGroupName -TargetUniqueIds $targetUniqueIds `
            -ReportedUniqueIds @(@($plan.Collateral) | ForEach-Object { $_.UniqueId }) `
            -NameLookup $tenantBaseline) }
            $results = @(Resolve-CollateralOutcome -SiteURL $SiteURL -Token $Token -Collateral $runCollateral -Results $results)
                Save-DeleteResults -Results $results -Timestamp $timestamp
            return
        }
    }

    # ---- Remove references and verify -------------------------------------
    # Only genuine mismatches gate. Pairs where both sides are being deleted are
    # 'NotApplicable' and known child-reference asymmetry is a warning; gating on
    # those meant 120 lines to adjudicate where 6 mattered.
    $mismatches = @($plan.Reconciliation | Where-Object { $_.Status -eq 'Mismatch' })
    if ($mismatches.Count -gt 0) {
        Write-Host "`n$($mismatches.Count) reconciliation mismatch(es) above." -ForegroundColor Red
        $continue = $false
        if (-not $Force) { $continue = ((Read-Host "Continue anyway? (Y/N)") -eq 'Y') }
        else { Write-Host "-Force does not wave through reconciliation mismatches. Stopping." -ForegroundColor Red }

        if (-not $continue) {
            Write-Host "Operation cancelled. Nothing has been deleted." -ForegroundColor Yellow
            Write-Host "Restored processes still need re-archiving; see $planPath" -ForegroundColor Yellow
            $results += @(Restore-ProcessPlanState -SiteURL $SiteURL -Token $Token -Plan $plan -PlanPath $planPath -ApprovalsEnabled $approvalsEnabled)
            if ($tempGroup) { $results += @(Remove-HoldingGroup -SiteURL $SiteURL -Token $Token -TempGroup $tempGroup -GroupName $TempGroupName -TargetUniqueIds $targetUniqueIds `
            -ReportedUniqueIds @(@($plan.Collateral) | ForEach-Object { $_.UniqueId }) `
            -NameLookup $tenantBaseline) }
            $results = @(Resolve-CollateralOutcome -SiteURL $SiteURL -Token $Token -Collateral $runCollateral -Results $results)
                Save-DeleteResults -Results $results -Timestamp $timestamp
            return
        }
    }

    $execution = Invoke-ProcessDeletePlan -SiteURL $SiteURL -Token $Token `
        -Plan $plan -PlanPath $planPath -ApprovalsEnabled $approvalsEnabled
    $results += @($execution.Results)

    if (@($execution.VerificationFailed).Count -gt 0) {
        Write-Host "`nVerification failed: references remain on $(@($execution.VerificationFailed).Count) process(es)." -ForegroundColor Red
        Write-Host "Deleting now would leave broken references behind." -ForegroundColor Red
        $continue = $false
        if (-not $Force) { $continue = ((Read-Host "Continue to deletion anyway? (Y/N)") -eq 'Y') }
        else { Write-Host "-Force does not wave through a failed verification. Stopping." -ForegroundColor Red }

        if (-not $continue) {
            Write-Host "Operation cancelled before deletion." -ForegroundColor Yellow
            $results += @(Restore-ProcessPlanState -SiteURL $SiteURL -Token $Token -Plan $plan -PlanPath $planPath -ApprovalsEnabled $approvalsEnabled)
            if ($tempGroup) { $results += @(Remove-HoldingGroup -SiteURL $SiteURL -Token $Token -TempGroup $tempGroup -GroupName $TempGroupName -TargetUniqueIds $targetUniqueIds `
            -ReportedUniqueIds @(@($plan.Collateral) | ForEach-Object { $_.UniqueId }) `
            -NameLookup $tenantBaseline) }
            $results = @(Resolve-CollateralOutcome -SiteURL $SiteURL -Token $Token -Collateral $runCollateral -Results $results)
                Save-DeleteResults -Results $results -Timestamp $timestamp
            return
        }
    }

    # ---- Delete -----------------------------------------------------------
    Write-Host "`n========================================" -ForegroundColor Red
    Write-Host "  PERMANENT DELETION" -ForegroundColor Red
    Write-Host "========================================" -ForegroundColor Red
    Write-Host "About to permanently delete $($targetUniqueIds.Count) process(es). This cannot be undone." -ForegroundColor Red

    $confirmed = $Force
    if ($Force) {
        Write-Host "-Force supplied: proceeding without the typed confirmation." -ForegroundColor Red
    } else {
        $confirmed = ((Read-Host "Type 'DELETE' to confirm") -eq 'DELETE')
    }

    if (-not $confirmed) {
        Write-Host "Deletion cancelled." -ForegroundColor Yellow
        $results += @(Restore-ProcessPlanState -SiteURL $SiteURL -Token $Token -Plan $plan -PlanPath $planPath -ApprovalsEnabled $approvalsEnabled)
        if ($tempGroup) { $results += @(Remove-HoldingGroup -SiteURL $SiteURL -Token $Token -TempGroup $tempGroup -GroupName $TempGroupName -TargetUniqueIds $targetUniqueIds `
            -ReportedUniqueIds @(@($plan.Collateral) | ForEach-Object { $_.UniqueId }) `
            -NameLookup $tenantBaseline) }
        $results = @(Resolve-CollateralOutcome -SiteURL $SiteURL -Token $Token -Collateral $runCollateral -Results $results)
                Save-DeleteResults -Results $results -Timestamp $timestamp
        return
    }

    # Whatever is sitting in the holding group is something this run touched,
    # whether or not any list sweep ever returned it. That is the one signal
    # available for a process the baseline could not cover.
    #
    # Passed as a closure rather than a list, because WHEN it is read decides
    # whether it contains anything. Read before the deletes it holds only the
    # targets, which are all expected and all skipped; the processes worth
    # catching are stranded there BY the delete. Each checkpoint calls this at
    # the moment it runs.
    $holdingGroupReader = {
        if (-not $tempGroup) { return @() }
        return @(Get-ProcessesFromGroup -SiteURL $SiteURL -Token $Token `
            -GroupID $tempGroup.id -GroupUniqueId $tempGroup.uniqueId -IncludeSubgroups $false |
            ForEach-Object { $_.processUniqueId } | Where-Object { $_ })
    }

    $deletionResults = @(Invoke-ProcessTargetDeletion -SiteURL $SiteURL -Token $Token -Plan $plan `
        -ApprovalsEnabled $approvalsEnabled -TenantBaseline $tenantBaseline -OnCollateral $collateralDecision `
        -GetObservedUniqueIds $holdingGroupReader)
    $results += $deletionResults
    $runCollateral += @($plan.Collateral)

    # The deletion step stops before deleting anything if the archive pass moved
    # something that was not a target. Unwind rather than carrying on.
    if (@($plan.Collateral).Count -gt 0 -and @($deletionResults | Where-Object { $_.Operation -eq 'Delete' }).Count -eq 0) {
        [void](Export-DependencyPlan -Plan $plan -Path $planPath)
        $results += @(Restore-ProcessPlanState -SiteURL $SiteURL -Token $Token -Plan $plan -PlanPath $planPath -ApprovalsEnabled $approvalsEnabled)
        $results += @(Restore-CollateralState -SiteURL $SiteURL -Token $Token -Collateral $plan.Collateral -ApprovalsEnabled $approvalsEnabled)
        if ($tempGroup) { $results += @(Remove-HoldingGroup -SiteURL $SiteURL -Token $Token -TempGroup $tempGroup -GroupName $TempGroupName -TargetUniqueIds $targetUniqueIds `
            -ReportedUniqueIds @(@($plan.Collateral) | ForEach-Object { $_.UniqueId }) `
            -NameLookup $tenantBaseline) }
        $results = @(Resolve-CollateralOutcome -SiteURL $SiteURL -Token $Token -Collateral $runCollateral -Results $results)
                Save-DeleteResults -Results $results -Timestamp $timestamp
        return
    }

    # ---- Restore original state ------------------------------------------
    $results += @(Restore-ProcessPlanState -SiteURL $SiteURL -Token $Token -Plan $plan -PlanPath $planPath -ApprovalsEnabled $approvalsEnabled)

    # ---- Clean up the holding group --------------------------------------
    if ($tempGroup) {
        Write-Host "`n=== CLEANUP ===" -ForegroundColor Cyan
        $results += @(Remove-HoldingGroup -SiteURL $SiteURL -Token $Token -TempGroup $tempGroup -GroupName $TempGroupName -TargetUniqueIds $targetUniqueIds `
            -ReportedUniqueIds @(@($plan.Collateral) | ForEach-Object { $_.UniqueId }) `
            -NameLookup $tenantBaseline)
    }

    # ---- Optional: delete the source group folders ------------------------
    if ($SourceType -eq "Group" -and $GroupUniqueId) {
        Write-Host "`n=== OPTIONAL: GROUP FOLDER CLEANUP ===" -ForegroundColor Cyan
        $deleteFolders = $false
        if (-not $Force) { $deleteFolders = ((Read-Host "Also delete the process group folders themselves? (Y/N)") -eq 'Y') }

        if ($deleteFolders) {
            $groupsToDelete = @(Get-GroupsInTree -SiteURL $SiteURL -Token $Token -RootGroupUniqueId $GroupUniqueId -IncludeRoot $true)

            if ($groupsToDelete.Count -eq 0) {
                Write-Host "No groups found to delete." -ForegroundColor Yellow
            } else {
                Write-Host "Deleting $($groupsToDelete.Count) group(s), children before parents..." -ForegroundColor Cyan
                foreach ($grp in $groupsToDelete) {
                    $ok = Delete-ProcessGroup -SiteURL $SiteURL -Token $Token -GroupUniqueId $grp.UniqueId -Silent
                    $results += [PSCustomObject]@{
                        ObjectType = 'ProcessGroup'; ObjectID = $grp.UniqueId; Name = $grp.Name
                        Operation = 'Delete'
                        Status = $(if ($ok) { 'Success' } else { 'Failed' })
                        Message = "Depth $($grp.Depth)"
                    }
                }
            }
        }
    }

    $plan.Status = 'Completed'
    [void](Export-DependencyPlan -Plan $plan -Path $planPath)
    $results = @(Resolve-CollateralOutcome -SiteURL $SiteURL -Token $Token -Collateral $runCollateral -Results $results)
                Save-DeleteResults -Results $results -Timestamp $timestamp
}

function Save-DeleteResults {
    param($Results, [string]$Timestamp)

    $outputPath = "Delete_Results_$Timestamp.csv"
    @($Results) | Export-Csv -Path $outputPath -NoTypeInformation

    $failed = @($Results | Where-Object { $_.Status -eq 'Failed' })
    $collateral = @($Results | Where-Object { $_.Operation -eq 'Collateral' })
    $unreversed = @($Results | Where-Object { $_.Operation -eq 'ReverseCollateral' -and $_.Status -ne 'Success' })

    Write-Host "`nResults saved to: $outputPath" -ForegroundColor Green
    Write-Host "Total operations: $(@($Results).Count)" -ForegroundColor Cyan
    Write-Host "Successful: $(@($Results | Where-Object { $_.Status -eq 'Success' }).Count)" -ForegroundColor Green
    Write-Host "Skipped: $(@($Results | Where-Object { $_.Status -eq 'Skipped' }).Count)" -ForegroundColor Yellow
    Write-Host "Failed: $($failed.Count)" -ForegroundColor Red

    # A run that changed processes nobody asked it to change is not a clean run,
    # and the counts alone let it read as one. An earlier run printed
    # "6 operations, 5 successful, 1 skipped, 0 failed" while five processes it
    # never named had changed state.
    if ($collateral.Count -gt 0) {
        # Merged by id. Two producers raise these (the checkpoints and the
        # holding-group sweep) and a process caught by both is one process, not
        # two: the count is of processes affected, not of rows emitted.
        $byProcess = @($collateral | Group-Object { ([string]$_.ObjectID).ToLowerInvariant() })

        Write-Host "`n========================================" -ForegroundColor Red
        Write-Host "  THIS RUN CHANGED PROCESSES IT WAS NOT ASKED TO" -ForegroundColor Red
        Write-Host "========================================" -ForegroundColor Red
        Write-Host "$($byProcess.Count) process(es) affected without being targets:" -ForegroundColor Red

        foreach ($group in $byProcess) {
            $rows = @($group.Group)
            $id = $rows[0].ObjectID

            # Longest name wins where they disagree: the group listing truncates
            # a variation name to its master's, so the fuller one is the real one.
            $label = $id
            $named = @($rows | Where-Object { $_.Name } | Sort-Object { ([string]$_.Name).Length } -Descending)
            if ($named.Count -gt 0) { $label = $named[0].Name }

            Write-Host "  $label  ($id)" -ForegroundColor Red
            foreach ($msg in @($rows | ForEach-Object { $_.Message } | Select-Object -Unique)) {
                Write-Host "      $msg" -ForegroundColor DarkGray
            }
        }

        if ($unreversed.Count -gt 0) {
            Write-Host "`n$($unreversed.Count) of these still need manual attention:" -ForegroundColor Red
            foreach ($u in $unreversed) {
                $label = if ($u.Name) { $u.Name } else { $u.ObjectID }
                Write-Host "  $label - $($u.Message)" -ForegroundColor Red
            }
        }
        Write-Host ""
    }
}

# ============================================================================
# MAIN MENU AND FLOW
# ============================================================================

function Show-MainMenu {
    Write-Host "`n============================================" -ForegroundColor Cyan
    Write-Host "  NINTEX PROCESS MANAGER BULK OPERATIONS" -ForegroundColor Cyan
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Select Operation Mode:" -ForegroundColor Yellow
    Write-Host "  [1] Bulk Archive" -ForegroundColor White
    Write-Host "  [2] Bulk Restore" -ForegroundColor White
    Write-Host "  [3] Bulk Update Location" -ForegroundColor White
    Write-Host "  [4] Bulk Update Ownership" -ForegroundColor White
    Write-Host "  [5] Bulk Delete Content" -ForegroundColor White
    Write-Host "  [Q] Quit" -ForegroundColor White
    Write-Host ""
}

function Get-SourceType {
    param([int]$Mode)

    # Mode 3 (Update Location) and 4 (Update Ownership) always use CSV
    if ($Mode -eq 3 -or $Mode -eq 4) {
        return "CSV"
    }

    # Mode 2 (Restore) can be CSV or All
    if ($Mode -eq 2) {
        Write-Host "`nSelect Source:" -ForegroundColor Yellow
        Write-Host "  [1] CSV File (restore specific items)" -ForegroundColor White
        Write-Host "  [2] All Archived Items in Site" -ForegroundColor White
        $choice = Read-Host "Choice"

        if ($choice -eq '2') {
            return "All"
        }
        return "CSV"
    }

    # Mode 5 (Bulk Delete): CSV, Group, Archived Processes, or Archived Documents
    if ($Mode -eq 5) {
        Write-Host "`nSelect Source:" -ForegroundColor Yellow
        Write-Host "  [1] CSV File" -ForegroundColor White
        Write-Host "  [2] Process/Document Group" -ForegroundColor White
        Write-Host "  [3] All Archived Processes" -ForegroundColor White
        Write-Host "  [4] All Archived Documents" -ForegroundColor White
        $choice = Read-Host "Choice"

        switch ($choice) {
            '2' { return "Group" }
            '3' { return "Archived" }
            '4' { return "ArchivedDocuments" }
            default { return "CSV" }
        }
    }

    # Other modes: CSV or Group
    Write-Host "`nSelect Source:" -ForegroundColor Yellow
    Write-Host "  [1] CSV File" -ForegroundColor White
    Write-Host "  [2] Process/Document Group" -ForegroundColor White
    $choice = Read-Host "Choice"

    if ($choice -eq '2') {
        return "Group"
    }
    return "CSV"
}

function Get-ObjectType {
    param([int]$Mode)

    # Mode 4 (Update Ownership) only supports Processes
    if ($Mode -eq 4) {
        return "Processes"
    }

    # Mode 5 (Delete) only supports Processes
    if ($Mode -eq 5) {
        return "Processes"
    }

    Write-Host "`nSelect Object Type:" -ForegroundColor Yellow
    Write-Host "  [1] Processes" -ForegroundColor White
    Write-Host "  [2] Documents" -ForegroundColor White
    Write-Host "  [3] Both" -ForegroundColor White
    $choice = Read-Host "Choice"

    switch ($choice) {
        '2' { return "Documents" }
        '3' { return "Both" }
        default { return "Processes" }
    }
}

function Get-DryRunChoice {
    Write-Host "`nExecution Mode:" -ForegroundColor Yellow
    Write-Host "  [1] Execute Operation (make changes)" -ForegroundColor White
    Write-Host "  [2] Preview/Dry-Run (no changes, show what would happen)" -ForegroundColor Cyan
    $choice = Read-Host "Choice"

    return ($choice -eq '2')
}

# ============================================================================
# PARAMETER RESOLUTION
# ============================================================================
# Each resolver returns the supplied parameter when there is one and prompts
# otherwise, so one copy of the mode dispatch serves both entry points.

$script:CliOptions = @{}

function Resolve-SourceType {
    param([int]$Mode)

    if ($script:CliOptions.Source) { return [string]$script:CliOptions.Source }
    if ($script:CliOptions.NonInteractive) {
        throw "-Source is required with -Mode $Mode"
    }
    return (Get-SourceType -Mode $Mode)
}

function Resolve-ObjectType {
    param([int]$Mode)

    if ($script:CliOptions.ObjectType) { return [string]$script:CliOptions.ObjectType }
    if ($script:CliOptions.NonInteractive) { return 'Process' }
    return (Get-ObjectType -Mode $Mode)
}

function Resolve-DryRunChoice {
    if ($script:CliOptions.NonInteractive) { return [bool]$script:CliOptions.WhatIf }
    return (Get-DryRunChoice)
}

function Resolve-CsvPath {
    param([string]$Hint = '')

    if ($script:CliOptions.CsvPath) { return [string]$script:CliOptions.CsvPath }
    if ($script:CliOptions.NonInteractive) {
        throw "-CsvPath is required for this mode and source"
    }

    $prompt = if ($Hint) { "Enter CSV file path ($Hint)" } else { 'Enter CSV file path' }
    return (Read-Host $prompt)
}

function Resolve-ProcessGroup {
    # Non-interactively the group comes from -GroupId, which means a lookup
    # rather than a picker.
    param([string]$SiteURL, [string]$Token, [string]$Prompt)

    if (-not $script:CliOptions.NonInteractive) {
        return (Select-ProcessGroup -SiteURL $SiteURL -Token $Token -Prompt $Prompt)
    }

    $id = [int]$script:CliOptions.GroupId
    if ($id -le 0) { throw '-GroupId is required with -Source Group' }

    $group = Get-ProcessGroupById -SiteURL $SiteURL -Token $Token -GroupId "$id"
    if (-not $group) { throw "Process group $id was not found" }
    return $group
}

function Resolve-RestoreGroupId {
    if ($script:CliOptions.NonInteractive) { return [int]$script:CliOptions.RestoreGroupId }
    return -1
}

# ============================================================================
# MODE DISPATCH
# ============================================================================

function Invoke-BulkOperationMode {
    <#
    .SYNOPSIS
        Runs one mode. Shared by the menu and the -Mode entry point.
    #>
    param(
        [string]$mode,
        $config,
        [string]$token
    )

    $running = $true   # 'Q' clears this; the menu loop reads it back
    switch ($mode) {
        '1' {  # Bulk Archive
            $sourceType = Resolve-SourceType -Mode 1
            $objectType = Resolve-ObjectType -Mode 1
            $isDryRun = Resolve-DryRunChoice

            if ($sourceType -eq "CSV") {
                $csvPath = Resolve-CsvPath
                if ($isDryRun) {
                    Invoke-BulkArchive -SiteURL $config.SiteURL -Token $token -SourceType $sourceType -ObjectType $objectType -CsvPath $csvPath -WhatIf
                } else {
                    Invoke-BulkArchive -SiteURL $config.SiteURL -Token $token -SourceType $sourceType -ObjectType $objectType -CsvPath $csvPath
                }
            } else {
                $group = Resolve-ProcessGroup -SiteURL $config.SiteURL -Token $token -Prompt "Select Group to Archive"
                if ($group) {
                    if ($isDryRun) {
                        Invoke-BulkArchive -SiteURL $config.SiteURL -Token $token -SourceType $sourceType -ObjectType $objectType -GroupID $group.id -GroupUniqueId $group.uniqueId -WhatIf
                    } else {
                        Invoke-BulkArchive -SiteURL $config.SiteURL -Token $token -SourceType $sourceType -ObjectType $objectType -GroupID $group.id -GroupUniqueId $group.uniqueId
                    }
                }
            }
        }

        '2' {  # Bulk Restore
            $sourceType = Resolve-SourceType -Mode 2
            $objectType = Resolve-ObjectType -Mode 2
            $isDryRun = Resolve-DryRunChoice

            # Get restore target group
            $restoreGroupId = -1
            if ($config.DefaultRestoreGroupID -and $config.DefaultRestoreGroupID -match '^\d+$') {
                $useDefault = if ($script:CliOptions.NonInteractive) { 'Y' } else { Read-Host "Use default restore group ID $($config.DefaultRestoreGroupID)? (Y/N)" }
                if ($useDefault -eq 'Y') {
                    $restoreGroupId = [int]$config.DefaultRestoreGroupID
                }
            }

            if ($restoreGroupId -lt 0) {
                $restoreGroup = Resolve-ProcessGroup -SiteURL $config.SiteURL -Token $token -Prompt "Select Target Group for Restore"
                if ($restoreGroup) {
                    $restoreGroupId = $restoreGroup.id
                }
            }

            if ($restoreGroupId -gt 0) {
                if ($sourceType -eq "CSV") {
                    $csvPath = Resolve-CsvPath
                    if ($isDryRun) {
                        Invoke-BulkRestore -SiteURL $config.SiteURL -Token $token -SourceType $sourceType -ObjectType $objectType -CsvPath $csvPath -RestoreGroupID $restoreGroupId -WhatIf
                    } else {
                        Invoke-BulkRestore -SiteURL $config.SiteURL -Token $token -SourceType $sourceType -ObjectType $objectType -CsvPath $csvPath -RestoreGroupID $restoreGroupId
                    }
                } else {
                    if ($isDryRun) {
                        Invoke-BulkRestore -SiteURL $config.SiteURL -Token $token -SourceType $sourceType -ObjectType $objectType -RestoreGroupID $restoreGroupId -WhatIf
                    } else {
                        Invoke-BulkRestore -SiteURL $config.SiteURL -Token $token -SourceType $sourceType -ObjectType $objectType -RestoreGroupID $restoreGroupId
                    }
                }
            }
        }

        '3' {  # Bulk Update Location
            $objectType = Resolve-ObjectType -Mode 3
            $csvPath = Resolve-CsvPath -Hint "must contain ID and NewGroupID columns"
            $isDryRun = Resolve-DryRunChoice
            if ($isDryRun) {
                Invoke-BulkUpdateLocation -SiteURL $config.SiteURL -Token $token -ObjectType $objectType -CsvPath $csvPath -WhatIf
            } else {
                Invoke-BulkUpdateLocation -SiteURL $config.SiteURL -Token $token -ObjectType $objectType -CsvPath $csvPath
            }
        }

        '4' {  # Bulk Update Ownership
            $csvPath = Resolve-CsvPath -Hint "must contain ProcessID, NewOwner, NewExpert columns"
            $isDryRun = Resolve-DryRunChoice
            if ($isDryRun) {
                Invoke-BulkUpdateOwnership -SiteURL $config.SiteURL -Token $token -CsvPath $csvPath -WhatIf
            } else {
                Invoke-BulkUpdateOwnership -SiteURL $config.SiteURL -Token $token -CsvPath $csvPath
            }
        }

        '5' {  # Bulk Delete Content
            $sourceType = Resolve-SourceType -Mode 5
            $isDryRun = Resolve-DryRunChoice

            $tempGroupName = $config.TempGroupName
            if (-not $tempGroupName) {
                $tempGroupName = "Bulk Delete Temporary Group"
            }

            # Unattended flags only. The interactive path leaves these off and
            # Invoke-BulkDeleteProcesses prompts exactly as it always did.
            $deleteSwitches = @{}
            if ($script:CliOptions.Force)            { $deleteSwitches.Force = $true }
            if ($script:CliOptions.ApprovalsEnabled) { $deleteSwitches.ApprovalsEnabled = $true }
            if ($script:CliOptions.ThoroughScan)     { $deleteSwitches.ThoroughScan = $true }
            if ($script:CliOptions.IncludeSubgroups) { $deleteSwitches.IncludeSubgroups = $true }
            if ($script:CliOptions.AllowUnheldTargets) { $deleteSwitches.AllowUnheldTargets = $true }

            if ($sourceType -eq "CSV") {
                $csvPath = Resolve-CsvPath
                if ($isDryRun) {
                    Invoke-BulkDeleteProcesses -SiteURL $config.SiteURL -Token $token -SourceType $sourceType -CsvPath $csvPath -TempGroupName $tempGroupName -CurrentUsername $config.Username -WhatIf @deleteSwitches
                } else {
                    Invoke-BulkDeleteProcesses -SiteURL $config.SiteURL -Token $token -SourceType $sourceType -CsvPath $csvPath -TempGroupName $tempGroupName -CurrentUsername $config.Username @deleteSwitches
                }
            } elseif ($sourceType -eq "Archived") {
                # Handle bulk delete of all archived processes
                if ($isDryRun) {
                    Invoke-BulkDeleteProcesses -SiteURL $config.SiteURL -Token $token -SourceType $sourceType -TempGroupName $tempGroupName -CurrentUsername $config.Username -WhatIf @deleteSwitches
                } else {
                    Invoke-BulkDeleteProcesses -SiteURL $config.SiteURL -Token $token -SourceType $sourceType -TempGroupName $tempGroupName -CurrentUsername $config.Username @deleteSwitches
                }
            } elseif ($sourceType -eq "ArchivedDocuments") {
                # Handle bulk delete of all archived documents
                Write-Host "`n=== BULK DELETE ALL ARCHIVED DOCUMENTS ===" -ForegroundColor Cyan

                # Fetch all archived documents
                Write-Host "`nFetching archived documents..." -ForegroundColor Cyan
                $archivedDocs = Get-AllArchivedDocuments -SiteURL $config.SiteURL -Token $token

                if ($archivedDocs.Count -eq 0) {
                    Write-Host "No archived documents found." -ForegroundColor Yellow
                } else {
                    # Display summary
                    Write-Host "`nFound $($archivedDocs.Count) archived document(s):" -ForegroundColor Yellow
                    Write-Host ""

                    # Show first 20 documents as preview
                    $previewCount = [Math]::Min(20, $archivedDocs.Count)
                    for ($i = 0; $i -lt $previewCount; $i++) {
                        $doc = $archivedDocs[$i]
                        Write-Host "  - $($doc.DocumentName) (Group: $($doc.PrimaryGroupName))" -ForegroundColor White
                    }
                    if ($archivedDocs.Count -gt 20) {
                        Write-Host "  ... and $($archivedDocs.Count - 20) more documents" -ForegroundColor Gray
                    }

                    if ($isDryRun) {
                        Write-Host "`n[DRY RUN] Would delete $($archivedDocs.Count) archived documents" -ForegroundColor Yellow
                    } else {
                        # Multiple confirmations for safety
                        Write-Host "`n========================================" -ForegroundColor Red
                        Write-Host "  WARNING: DESTRUCTIVE OPERATION" -ForegroundColor Red
                        Write-Host "========================================" -ForegroundColor Red
                        Write-Host "This will PERMANENTLY DELETE all $($archivedDocs.Count) archived documents." -ForegroundColor Red
                        Write-Host "This action CANNOT be undone." -ForegroundColor Red
                        Write-Host ""

                        $confirm1 = if ($script:CliOptions.Force) { 'DELETE ALL DOCUMENTS' } else { Read-Host "Type 'DELETE ALL DOCUMENTS' to confirm" }
                        if ($confirm1 -eq 'DELETE ALL DOCUMENTS') {
                            Write-Host "`nDeleting archived documents..." -ForegroundColor Cyan

                            # Extract document IDs for deletion
                            $documentIds = $archivedDocs | ForEach-Object { $_.DocumentId }

                            $result = Delete-ArchivedDocuments -SiteURL $config.SiteURL -Token $token -DocumentIds $documentIds

                            Write-Host "`n=== Deletion Summary ===" -ForegroundColor Cyan
                            Write-Host "Documents deleted: $($result.Deleted)" -ForegroundColor Green
                            if ($result.Failed -gt 0) {
                                Write-Host "Documents failed: $($result.Failed)" -ForegroundColor Red
                            }
                        } else {
                            Write-Host "Operation cancelled." -ForegroundColor Yellow
                        }
                    }
                }
            } else {
                $group = Resolve-ProcessGroup -SiteURL $config.SiteURL -Token $token -Prompt "Select Group to Delete (WARNING: Destructive!)"
                if ($group) {
                    if ($isDryRun) {
                        Invoke-BulkDeleteProcesses -SiteURL $config.SiteURL -Token $token -SourceType $sourceType -GroupID $group.id -GroupUniqueId $group.uniqueId -TempGroupName $tempGroupName -CurrentUsername $config.Username -WhatIf @deleteSwitches
                    } else {
                        Invoke-BulkDeleteProcesses -SiteURL $config.SiteURL -Token $token -SourceType $sourceType -GroupID $group.id -GroupUniqueId $group.uniqueId -TempGroupName $tempGroupName -CurrentUsername $config.Username @deleteSwitches
                    }
                }
            }
        }

        'Q' {
            $running = $false
            Write-Host "`nExiting..." -ForegroundColor Cyan
        }

        default {
            Write-Host "Invalid selection. Please try again." -ForegroundColor Red
        }
    }


    return $running
}

# ============================================================================
# MAIN SCRIPT
# ============================================================================

function Start-BulkOperations {
    param(
        [string]$Mode,
        [string]$Source,
        [string]$CsvPath,
        [int]$GroupId = -1,
        [string]$ObjectType,
        [int]$RestoreGroupId = -1,
        [string]$ConfigPath = 'config.txt',
        [switch]$WhatIf,
        [switch]$Force,
        [switch]$ApprovalsEnabled,
        [switch]$ThoroughScan,
        [switch]$IncludeSubgroups,
        [switch]$AllowUnheldTargets
    )

    $nonInteractive = [bool]$Mode

    $script:CliOptions = @{
        NonInteractive   = $nonInteractive
        Source           = $Source
        CsvPath          = $CsvPath
        GroupId          = $GroupId
        ObjectType       = $ObjectType
        RestoreGroupId   = $RestoreGroupId
        WhatIf           = [bool]$WhatIf
        Force            = [bool]$Force
        ApprovalsEnabled = [bool]$ApprovalsEnabled
        ThoroughScan     = [bool]$ThoroughScan
        IncludeSubgroups = [bool]$IncludeSubgroups
        AllowUnheldTargets = [bool]$AllowUnheldTargets
    }

    # Clearing the screen throws away whatever the caller was looking at, which
    # is fine for a menu session and wrong for a scripted run.
    if (-not $nonInteractive) { Clear-Host }

    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host "  NINTEX PROCESS MANAGER BULK OPERATIONS" -ForegroundColor Cyan
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host "  Version $script:ScriptVersion" -ForegroundColor Yellow
    Write-Host "  Script loaded: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Yellow
    Write-Host ""

    $config = Read-ConfigFile -ConfigPath $ConfigPath
    if (-not $config) {
        Write-Host "Cannot proceed without valid configuration" -ForegroundColor Red
        return 2
    }

    $token = Get-AuthToken -SiteURL $config.SiteURL -Username $config.Username -Password $config.Password
    if (-not $token) {
        Write-Host "Authentication failed. Cannot proceed." -ForegroundColor Red
        return 3
    }

    # ---- Non-interactive: run the one mode and exit with a status code ----
    if ($nonInteractive) {
        Write-Host "Running mode $Mode non-interactively." -ForegroundColor Cyan
        try {
            [void](Invoke-BulkOperationMode -mode $Mode -config $config -token $token)
        }
        catch {
            Write-Host "Mode $Mode failed: $($_.Exception.Message)" -ForegroundColor Red
            Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
            return 1
        }
        return 0
    }

    # ---- Interactive menu -------------------------------------------------
    # The invalid-selection counter is the other half of the redirected-stdin
    # fix: with stdin closed Read-Host returns nothing forever, and without a
    # cap that is an infinite loop printing "Invalid selection" until killed.
    $running = $true
    $invalidSelections = 0
    $maxInvalidSelections = 5

    while ($running) {
        Show-MainMenu
        $selection = Read-Host "Select Mode"

        if ($selection -notmatch '^[1-5Qq]$') {
            $invalidSelections++
            Write-Host "Invalid selection. Please try again. ($invalidSelections of $maxInvalidSelections)" -ForegroundColor Red

            if ($invalidSelections -ge $maxInvalidSelections) {
                Write-Host "Too many invalid selections; exiting." -ForegroundColor Red
                Write-Host "If you meant to script this, use -Mode. See Get-Help .\Nintex-BulkOperations.ps1." -ForegroundColor Yellow
                return 1
            }
            Wait-ForKeyPress
            continue
        }

        $invalidSelections = 0
        $running = Invoke-BulkOperationMode -mode $selection.ToUpperInvariant() -config $config -token $token

        if ($running) { Wait-ForKeyPress }
    }

    Write-Host "Thank you for using Nintex Process Manager Bulk Operations!" -ForegroundColor Green
    return 0
}

function Wait-ForKeyPress {
    # ReadKey throws outright when console input is redirected, which is every
    # scripted or piped invocation. There is nothing to wait for in that case.
    if ([Console]::IsInputRedirected -or $null -eq $Host.UI.RawUI) { return }

    Write-Host "`nPress any key to continue..." -ForegroundColor Gray
    try {
        $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    }
    catch {
        # Some hosts (ISE, remoting) have a RawUI that cannot read keys either.
        Start-Sleep -Milliseconds 250
    }
}

# ----------------------------------------------------------------------------
# Entry point.
#
# Dot-sourcing (". .\Nintex-BulkOperations.ps1") loads the functions and runs
# nothing, so tests and other scripts can use them. Running the file normally
# starts the program. Without this guard the menu executed at load and there was
# no way to reach a single function from outside.
# ----------------------------------------------------------------------------
if ($MyInvocation.InvocationName -ne '.') {
    $exitCode = Start-BulkOperations -Mode $Mode -Source $Source -CsvPath $CsvPath `
        -GroupId $GroupId -ObjectType $ObjectType -RestoreGroupId $RestoreGroupId `
        -ConfigPath $ConfigPath -WhatIf:$WhatIf -Force:$Force `
        -ApprovalsEnabled:$ApprovalsEnabled -ThoroughScan:$ThoroughScan `
        -IncludeSubgroups:$IncludeSubgroups -AllowUnheldTargets:$AllowUnheldTargets

    exit $exitCode
}
