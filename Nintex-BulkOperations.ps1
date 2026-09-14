# Nintex Process Manager Bulk Operations Script
# Version 4.0 (Archived Document Deletion)
# Supports: Archive, Restore, Update Location, Update Ownership, and Delete operations

#Requires -Version 5.1

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

function Get-ArchivedProcesses {
    param(
        [string]$SiteURL,
        [string]$Token,
        [int]$GroupID = -1
    )

    Write-Host "  Fetching archived processes..." -ForegroundColor Gray

    $allProcesses = @()
    $pageSize = 200
    $page = 1

    do {
        $url = "$SiteURL/Bff/Process/api/v1/processes?Page=$page&PageSize=$pageSize&ListType=7"
        $response = Invoke-ApiGet -Url $url -Token $Token

        if ($response -and $response.items) {
            Write-Host "    Page ${page}: Found $($response.items.Count) archived processes" -ForegroundColor Gray

            if ($GroupID -gt 0) {
                $groupProcesses = $response.items | Where-Object {
                    $_.groupId -eq $GroupID
                }
                $allProcesses += $groupProcesses
            } else {
                $allProcesses += $response.items
            }
        }

        $page++
    } while ($response -and $response.items -and $response.items.Count -eq $pageSize)

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
            $includeSubgroups = (Read-Host "Include subgroups? (Y/N)") -eq 'Y'
            $processes = Get-ProcessesFromGroup -SiteURL $SiteURL -Token $Token -GroupID $GroupID -GroupUniqueId $GroupUniqueId -IncludeSubgroups $includeSubgroups
            $processesToArchive = $processes | ForEach-Object { $_.processUniqueId }
            Write-Host "Found $($processesToArchive.Count) processes to archive" -ForegroundColor Green
        }

        if ($ObjectType -eq "Documents" -or $ObjectType -eq "Both") {
            $includeSubgroups = (Read-Host "Include subgroups for documents? (Y/N)") -eq 'Y'
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
        $continue = Read-Host "Continue anyway? Rows with invalid groups will fail. (Y/N)"
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
        $continue = Read-Host "Continue anyway? Rows with invalid users may fail. (Y/N)"
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
# MODE 5: BULK DELETE PROCESSES (OPTIMIZED)
# ============================================================================
#
# OPTIMIZATION IMPROVEMENTS:
# 1. Asks user if process approvals are enabled at the start
# 2. Uses CheckProcessDependencies API to find all dependencies for each process
# 3. Implements Approach A: Stores all dependencies and identifies duplicates
#    - More efficient: Only updates each dependent process once
#    - Better visibility: Shows full dependency summary before proceeding
# 4. Checks status of dependent processes using mobile API
# 5. Restores only archived dependencies to temporary group before updating
# 6. Removes dependencies intelligently based on type:
#    - Linked Process: Automatic removal via JSON update and re-publish
#    - Linked Process Group: Informational only (no removal needed)
#    - Other types: Manual removal with user prompts and validation
# 7. Re-archives restored dependencies after delete operation
#
# WORKFLOW:
# Phase 1: Gather processes to delete and get their UniqueIds
# Phase 2: Check dependencies using CheckProcessDependencies API
#          - Tracks unique dependencies by Type|UniqueId
#          - Shows which processes reference each dependency
#          - Displays summary and asks for user confirmation
# Phase 3: Create temporary group for restoring archived dependencies
# Phase 4: Check status of each dependency, restore archived ones
# Phase 5: Remove dependencies from dependent processes
#          - Automatic: Linked Process dependencies via JSON update
#          - Informational: Linked Process Group dependencies (no action)
#          - Manual: Other dependency types with user validation loop
#          - Validates all manual dependencies are removed before proceeding
# Phase 6-10: Original delete workflow (ownership, archive, delete, cleanup)
# ============================================================================

function Get-ProcessDependencies {
    param(
        [string]$SiteURL,
        [string]$Token,
        [string]$ProcessUniqueId
    )

    try {
        $url = "$SiteURL/Api/v1/Processes/$ProcessUniqueId/CheckProcessDependencies?searchBehavior=15"
        $response = Invoke-ApiGet -Url $url -Token $Token
        return $response
    }
    catch {
        Write-Host "  Error checking dependencies for process $ProcessUniqueId : $($_.Exception.Message)" -ForegroundColor Yellow
        return @()
    }
}

function Get-ProcessStatus {
    param(
        [string]$SiteURL,
        [string]$Token,
        [string]$ProcessUniqueId
    )

    try {
        # Use the regular API endpoint to get current working state (not cached published state)
        $url = "$SiteURL/Api/v1/Processes/$ProcessUniqueId"
        $response = Invoke-ApiGet -Url $url -Token $Token

        if ($response -and $response.processJson) {
            return $response.processJson
        }
        return $null
    }
    catch {
        Write-Host "  Error getting status for process $ProcessUniqueId : $($_.Exception.Message)" -ForegroundColor Yellow
        return $null
    }
}

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

function Delete-Process {
    param(
        [string]$SiteURL,
        [string]$Token,
        [string]$ProcessUniqueId,
        [string]$ProcessGroupUniqueId
    )

    try {
        # Delete the process using the correct API format
        $deleteUrl = "$SiteURL/Process/Edit/DeleteProcess"
        $deleteBody = @{
            processUniqueId = $ProcessUniqueId
        }

        # Add processGroupUniqueId if available
        if ($ProcessGroupUniqueId) {
            $deleteBody.processGroupUniqueId = $ProcessGroupUniqueId
        }

        $deleteResult = Invoke-ApiPost -Url $deleteUrl -Token $Token -Body $deleteBody

        if ($deleteResult -ne $null) {
            return $true
        } else {
            return $false
        }
    }
    catch {
        Write-Host "  Delete error: $($_.Exception.Message)" -ForegroundColor Red
        return $false
    }
}

# Returns an array of dependency types found (e.g., @("Linked Process", "Process Input", "Process Output"))
function Find-ProcessDependenciesInJson {
    param(
        [string]$ProcessJson,
        [string]$TargetProcessUniqueId
    )

    $foundTypes = @()

    # Convert JSON string to object
    $processObj = $ProcessJson | ConvertFrom-Json

    # Check ProcessProcedures.ProcessLink
    if ($processObj.ProcessProcedures.ProcessLink) {
        $found = @($processObj.ProcessProcedures.ProcessLink | Where-Object {
            $_.LinkedProcessUniqueId -eq $TargetProcessUniqueId
        })
        if ($found.Count -gt 0) {
            $foundTypes += "Linked Process"
        }
    }

    # Check ChildProcessProcedures in Activities
    if ($processObj.ProcessProcedures.Activity) {
        foreach ($activity in $processObj.ProcessProcedures.Activity) {
            if ($activity.ChildProcessProcedures) {
                $childTypes = @('Note', 'Task', 'Information', 'Form', 'Guide', 'Image', 'Policy', 'Training', 'Video', 'WebLink')

                foreach ($childType in $childTypes) {
                    if ($activity.ChildProcessProcedures.$childType) {
                        foreach ($child in $activity.ChildProcessProcedures.$childType) {
                            if ($child.LinkedProcessUniqueId -eq $TargetProcessUniqueId) {
                                if ($foundTypes -notcontains "Linked Process") {
                                    $foundTypes += "Linked Process"
                                }
                                break
                            }
                        }
                    }
                }
            }
        }
    }

    # Check ProcessProcedures.Decision
    if ($processObj.ProcessProcedures.Decision) {
        $found = @($processObj.ProcessProcedures.Decision | Where-Object {
            $_.LinkedProcessUniqueId -eq $TargetProcessUniqueId
        })
        if ($found.Count -gt 0) {
            if ($foundTypes -notcontains "Linked Process") {
                $foundTypes += "Linked Process"
            }
        }
    }

    # Check Inputs
    if ($processObj.Inputs -and $processObj.Inputs.Input) {
        $found = @($processObj.Inputs.Input | Where-Object {
            $_.FromProcessUniqueId -eq $TargetProcessUniqueId
        })
        if ($found.Count -gt 0) {
            $foundTypes += "Process Input"
        }
    }

    # Check Outputs
    if ($processObj.Outputs -and $processObj.Outputs.Output) {
        $found = @($processObj.Outputs.Output | Where-Object {
            $_.ToProcessUniqueId -eq $TargetProcessUniqueId
        })
        if ($found.Count -gt 0) {
            $foundTypes += "Process Output"
        }
    }

    return $foundTypes
}

# Legacy function for backwards compatibility - returns boolean
function Find-ProcessLinksInJson {
    param(
        [string]$ProcessJson,
        [string]$TargetProcessUniqueId
    )

    $foundTypes = Find-ProcessDependenciesInJson -ProcessJson $ProcessJson -TargetProcessUniqueId $TargetProcessUniqueId
    return ($foundTypes.Count -gt 0)
}

function Get-ArchivedProcessDependencies {
    param(
        [string]$SiteURL,
        [string]$Token,
        [hashtable]$ProcessDeleteMap
    )

    $archivedDependencies = @()
    $page = 1
    $pageSize = 20
    $hasMore = $true
    $totalProcessesChecked = 0

    # Step 1: Fetch all archived processes with pagination
    while ($hasMore) {
        try {
            $listUrl = "$SiteURL/Bff/Process/api/v1/processes?Page=$page&PageSize=$pageSize&ListType=7"
            $response = Invoke-ApiGet -Url $listUrl -Token $Token

            if ($response -and $response.items -and $response.items.Count -gt 0) {
                # Update progress indicator (single line)
                Write-Host "`r  Scanning archived processes... Page $page ($($response.items.Count) processes)" -NoNewline -ForegroundColor Gray

                # Collect UniqueIds for batch fetching
                $uniqueIds = $response.items | ForEach-Object { $_.processUniqueId }

                # Step 2: Batch fetch archived process details using mobile API
                # NOTE: For ARCHIVED processes, use the mobile API with batch fetching
                #       /mobile/api/v1/processes?processUniqueIds={guid1}&processUniqueIds={guid2}
                $batchSize = 15
                for ($i = 0; $i -lt $uniqueIds.Count; $i += $batchSize) {
                    $batch = $uniqueIds[$i..[Math]::Min($i + $batchSize - 1, $uniqueIds.Count - 1)]

                    # Build URL with multiple processUniqueIds query parameters
                    $queryParams = $batch | ForEach-Object { "processUniqueIds=$_" }
                    $batchUrl = "$SiteURL/mobile/api/v1/processes?" + ($queryParams -join '&')

                    try {
                        $batchResponse = Invoke-ApiGet -Url $batchUrl -Token $Token

                        if ($batchResponse -and $batchResponse.data -and $batchResponse.data.Count -gt 0) {
                            # Step 3: Search each archived process for links to processes being deleted
                            foreach ($archivedProcess in $batchResponse.data) {
                                $totalProcessesChecked++
                                $archivedUniqueId = $archivedProcess.ProcessModel.UniqueId
                                $archivedName = $archivedProcess.ProcessModel.Name
                                $archivedProcessJson = $archivedProcess.ProcessModel | ConvertTo-Json -Depth 20 -Compress

                                # Check if this archived process has dependencies to any process being deleted
                                foreach ($processKey in $ProcessDeleteMap.Keys) {
                                    $processInfo = $ProcessDeleteMap[$processKey]
                                    $targetUniqueId = $processInfo.UniqueId

                                    # Get all dependency types found (Linked Process, Process Input, Process Output)
                                    $foundDepTypes = Find-ProcessDependenciesInJson -ProcessJson $archivedProcessJson -TargetProcessUniqueId $targetUniqueId

                                    if ($foundDepTypes.Count -gt 0) {
                                        # Add an entry for each dependency type found
                                        foreach ($depType in $foundDepTypes) {
                                            # Show on new line when dependency found
                                            Write-Host ""
                                            Write-Host "    Found: $archivedName has $depType to process $targetUniqueId" -ForegroundColor Yellow

                                            # Add to dependencies list
                                            $archivedDependencies += @{
                                                Type = $depType
                                                UniqueId = $archivedUniqueId
                                                Name = $archivedName
                                                ReferencedProcessKey = $processKey
                                                IsArchived = $true
                                            }
                                        }

                                        # Resume progress indicator
                                        Write-Host "`r  Scanning archived processes... Page $page ($totalProcessesChecked processes checked)" -NoNewline -ForegroundColor Gray
                                    }
                                }
                            }
                        }
                    }
                    catch {
                        Write-Host ""  # New line before error
                        Write-Host "  Warning: Failed to fetch batch of archived processes: $($_.Exception.Message)" -ForegroundColor Yellow
                        # Resume progress indicator
                        Write-Host "`r  Scanning archived processes... Page $page ($totalProcessesChecked processes checked)" -NoNewline -ForegroundColor Gray
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
            Write-Host ""  # New line before error
            Write-Host "  Warning: Failed to fetch archived processes page $page : $($_.Exception.Message)" -ForegroundColor Yellow
            $hasMore = $false
        }
    }

    Write-Host ""  # New line after progress indicator

    return $archivedDependencies
}

function Get-ActiveProcessDependencies {
    param(
        [string]$SiteURL,
        [string]$Token,
        [hashtable]$ProcessDeleteMap
    )

    $activeDependencies = @()
    $totalChecked = 0
    $totalTargets = $ProcessDeleteMap.Keys.Count

    # CheckProcessDependencies returns a BIDIRECTIONAL union: both what the target
    # references and what references the target, with nothing in the payload to tell
    # them apart. The "incoming dependencies" framing below is WRONG and is retained
    # only to describe current behaviour. See API_ARCHITECTURE.md, "Dependency Checking
    # APIs", before relying on any of this.
    #
    # Known-incorrect in this implementation:
    #   - searchBehavior should be 31, not 15
    #   - results must NOT be deduplicated; every occurrence is a separate site
    #   - callers must fetch and walk BOTH sides to learn where a reference lives
    foreach ($processKey in $ProcessDeleteMap.Keys) {
        $totalChecked++
        $processInfo = $ProcessDeleteMap[$processKey]
        $targetUniqueId = $processInfo.UniqueId

        # Update progress indicator
        Write-Host "`r  Checking dependencies for target process $totalChecked of $totalTargets..." -NoNewline -ForegroundColor Gray

        try {
            # Call the CheckProcessDependencies API
            $url = "$SiteURL/Api/v1/Processes/$targetUniqueId/CheckProcessDependencies?searchBehavior=15"
            $dependencies = Invoke-ApiGet -Url $url -Token $Token

            if ($dependencies) {
                # PowerShell's ConvertFrom-Json converts single-element arrays to single objects
                # We need to handle both cases: array or single object
                $depArray = @()
                if ($dependencies -is [Array]) {
                    $depArray = $dependencies
                } else {
                    # Single object - wrap it in an array
                    $depArray = @($dependencies)
                }

                foreach ($depType in $depArray) {
                    $typeName = $depType.Type

                    # Process all automatic dependency types: Linked Process, Process Input, Process Output
                    if (($typeName -eq "Linked Process" -or $typeName -eq "Process Input" -or $typeName -eq "Process Output") -and $depType.Dependencies) {
                        foreach ($dep in $depType.Dependencies) {
                            $depUniqueId = $dep.UniqueId
                            $depName = $dep.Name

                            # Show on new line when dependency found
                            Write-Host ""
                            Write-Host "    Found: $depName has $typeName to process $targetUniqueId" -ForegroundColor Yellow

                            # Add to dependencies list
                            $activeDependencies += @{
                                Type = $typeName
                                UniqueId = $depUniqueId
                                Name = $depName
                                ReferencedProcessKey = $processKey
                                IsArchived = $false
                            }

                            # Resume progress indicator
                            Write-Host "`r  Checking dependencies for target process $totalChecked of $totalTargets..." -NoNewline -ForegroundColor Gray
                        }
                    }
                }
            }
        }
        catch {
            Write-Host ""  # New line before error
            Write-Host "  Warning: Failed to check dependencies for process $targetUniqueId : $($_.Exception.Message)" -ForegroundColor Yellow
            Write-Host "`r  Checking dependencies for target process $totalChecked of $totalTargets..." -NoNewline -ForegroundColor Gray
        }
    }

    Write-Host ""  # New line after progress indicator

    return $activeDependencies
}

function Get-AllArchivedProcesses {
    param(
        [string]$SiteURL,
        [string]$Token
    )

    Write-Host "  Fetching all archived processes from site..." -ForegroundColor Gray

    $allArchivedProcesses = @()
    $page = 1
    $pageSize = 20
    $hasMore = $true

    # Fetch all archived processes with pagination
    while ($hasMore) {
        try {
            # ListType=7 is for archived processes
            $listUrl = "$SiteURL/Bff/Process/api/v1/processes?Page=$page&PageSize=$pageSize&ListType=7"
            $response = Invoke-ApiGet -Url $listUrl -Token $Token

            if ($response -and $response.items -and $response.items.Count -gt 0) {
                Write-Host "  Page $page : Found $($response.items.Count) archived processes" -ForegroundColor Gray

                # Add each process UniqueId to the list
                foreach ($item in $response.items) {
                    $allArchivedProcesses += $item.processUniqueId
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
            Write-Host "  Error fetching archived processes: $($_.Exception.Message)" -ForegroundColor Red
            $hasMore = $false
        }
    }

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

function Remove-ProcessLinksFromJson {
    param(
        [string]$ProcessJson,
        [string]$TargetProcessUniqueId
    )

    # Convert JSON string to object
    $processObj = $ProcessJson | ConvertFrom-Json

    $linksRemoved = 0
    $processIdsToRemove = @()  # Track ProcessIds to remove from LinkedStakeholders

    # Remove from ProcessProcedures.ProcessLink
    if ($processObj.ProcessProcedures.ProcessLink) {
        $originalCount = @($processObj.ProcessProcedures.ProcessLink).Count
        # Track which ProcessIds we're removing
        foreach ($link in $processObj.ProcessProcedures.ProcessLink) {
            if ($link.LinkedProcessUniqueId -eq $TargetProcessUniqueId -and $link.LinkedProcessId) {
                $processIdsToRemove += $link.LinkedProcessId
            }
        }
        $processObj.ProcessProcedures.ProcessLink = @($processObj.ProcessProcedures.ProcessLink | Where-Object {
            $_.LinkedProcessUniqueId -ne $TargetProcessUniqueId
        })
        $newCount = @($processObj.ProcessProcedures.ProcessLink).Count
        $linksRemoved += ($originalCount - $newCount)
    }

    # Remove from ProcessProcedures.OrphanProcessLink
    if ($processObj.ProcessProcedures.OrphanProcessLink) {
        $originalCount = @($processObj.ProcessProcedures.OrphanProcessLink).Count
        # Track which ProcessIds we're removing
        foreach ($link in $processObj.ProcessProcedures.OrphanProcessLink) {
            if ($link.LinkedProcessUniqueId -eq $TargetProcessUniqueId -and $link.LinkedProcessId) {
                $processIdsToRemove += $link.LinkedProcessId
            }
        }
        $processObj.ProcessProcedures.OrphanProcessLink = @($processObj.ProcessProcedures.OrphanProcessLink | Where-Object {
            $_.LinkedProcessUniqueId -ne $TargetProcessUniqueId
        })
        $newCount = @($processObj.ProcessProcedures.OrphanProcessLink).Count
        $linksRemoved += ($originalCount - $newCount)
    }

    # Recursively clean ChildProcessProcedures in Activities
    if ($processObj.ProcessProcedures.Activity) {
        foreach ($activity in $processObj.ProcessProcedures.Activity) {
            if ($activity.ChildProcessProcedures) {
                # Check each child type (Note, Task, Information, etc.)
                $childTypes = @('Note', 'Task', 'Information', 'Form', 'Guide', 'Image', 'Policy', 'Training', 'Video', 'WebLink')

                foreach ($childType in $childTypes) {
                    if ($activity.ChildProcessProcedures.$childType) {
                        foreach ($child in $activity.ChildProcessProcedures.$childType) {
                            if ($child.LinkedProcessUniqueId -eq $TargetProcessUniqueId) {
                                # Track ProcessId for LinkedStakeholders removal
                                if ($child.LinkedProcessId) {
                                    $processIdsToRemove += $child.LinkedProcessId
                                }
                                # Clear the linked process fields
                                $child.LinkedProcessId = $null
                                $child.LinkedProcessUniqueId = $null
                                $child.LinkedProcessName = $null
                                $child.LinkedProcessDisplayName = $null
                                $child.LinkedProcessGroupId = $null
                                $child.LinkedProcessGroupName = $null
                                $child.LinkedProcessGroupUniqueId = $null
                                $linksRemoved++
                            }
                        }
                    }
                }
            }
        }
    }

    # Orphan Decision node links (don't fully remove them)
    # Decision links should be "orphaned" so users can see what was linked
    # This is done by clearing the link reference but keeping the display name
    if ($processObj.ProcessProcedures.Decision) {
        foreach ($decision in $processObj.ProcessProcedures.Decision) {
            if ($decision.LinkedProcessUniqueId -eq $TargetProcessUniqueId) {
                # Track ProcessId (though we won't remove from LinkedStakeholders)
                if ($decision.LinkedProcessId) {
                    $processIdsToRemove += $decision.LinkedProcessId
                }

                # Orphan the decision link:
                # - Clear the process references (ID, UniqueId, Name)
                # - KEEP LinkedProcessDisplayName so users see what was linked
                # - Change DecisionLinkType from 4 (linked) to 7 (orphaned)
                $decision.LinkedProcessId = $null
                $decision.LinkedProcessUniqueId = $null
                $decision.LinkedProcessName = $null
                # LinkedProcessDisplayName - KEEP AS IS (don't set to null)
                $decision.LinkedProcessGroupId = $null
                $decision.LinkedProcessGroupName = $null
                $decision.LinkedProcessGroupUniqueId = $null

                # Change DecisionLinkType from 4 (linked) to 7 (orphaned/broken link)
                if ($decision.DecisionLinkType -eq 4) {
                    $decision.DecisionLinkType = 7
                }

                $linksRemoved++
            }
        }
    }

    # NOTE: We do NOT remove from LinkedStakeholders
    # LinkedStakeholders is a reference cache that helps Process Manager track related processes
    # The UI uses this to show process relationships, and it should be preserved

    # Convert back to JSON string
    $cleanedJson = $processObj | ConvertTo-Json -Depth 20 -Compress

    return @{
        CleanedJson = $cleanedJson
        LinksRemoved = $linksRemoved
    }
}

# Object-based version that works directly with PSObjects (avoids double serialization)
function Remove-ProcessLinksFromObject {
    param(
        [object]$ProcessObj,
        [string]$TargetProcessUniqueId
    )

    $linksRemoved = 0

    # Remove from ProcessProcedures.ProcessLink
    if ($ProcessObj.ProcessProcedures.ProcessLink) {
        $originalCount = @($ProcessObj.ProcessProcedures.ProcessLink).Count
        $ProcessObj.ProcessProcedures.ProcessLink = @($ProcessObj.ProcessProcedures.ProcessLink | Where-Object {
            $_.LinkedProcessUniqueId -ne $TargetProcessUniqueId
        })
        $newCount = @($ProcessObj.ProcessProcedures.ProcessLink).Count
        $linksRemoved += ($originalCount - $newCount)
    }

    # Remove from ProcessProcedures.OrphanProcessLink
    if ($ProcessObj.ProcessProcedures.OrphanProcessLink) {
        $originalCount = @($ProcessObj.ProcessProcedures.OrphanProcessLink).Count
        $ProcessObj.ProcessProcedures.OrphanProcessLink = @($ProcessObj.ProcessProcedures.OrphanProcessLink | Where-Object {
            $_.LinkedProcessUniqueId -ne $TargetProcessUniqueId
        })
        $newCount = @($ProcessObj.ProcessProcedures.OrphanProcessLink).Count
        $linksRemoved += ($originalCount - $newCount)
    }

    # Recursively clean ChildProcessProcedures in Activities
    if ($ProcessObj.ProcessProcedures.Activity) {
        foreach ($activity in $ProcessObj.ProcessProcedures.Activity) {
            if ($activity.ChildProcessProcedures) {
                $childTypes = @('Note', 'Task', 'Information', 'Form', 'Guide', 'Image', 'Policy', 'Training', 'Video', 'WebLink')

                foreach ($childType in $childTypes) {
                    if ($activity.ChildProcessProcedures.$childType) {
                        foreach ($child in $activity.ChildProcessProcedures.$childType) {
                            if ($child.LinkedProcessUniqueId -eq $TargetProcessUniqueId) {
                                $child.LinkedProcessId = $null
                                $child.LinkedProcessUniqueId = $null
                                $child.LinkedProcessName = $null
                                $child.LinkedProcessDisplayName = $null
                                $child.LinkedProcessGroupId = $null
                                $child.LinkedProcessGroupName = $null
                                $child.LinkedProcessGroupUniqueId = $null
                                $linksRemoved++
                            }
                        }
                    }
                }
            }
        }
    }

    # Orphan Decision node links
    if ($ProcessObj.ProcessProcedures.Decision) {
        foreach ($decision in $ProcessObj.ProcessProcedures.Decision) {
            if ($decision.LinkedProcessUniqueId -eq $TargetProcessUniqueId) {
                $decision.LinkedProcessId = $null
                $decision.LinkedProcessUniqueId = $null
                $decision.LinkedProcessName = $null
                $decision.LinkedProcessGroupId = $null
                $decision.LinkedProcessGroupName = $null
                $decision.LinkedProcessGroupUniqueId = $null

                if ($decision.DecisionLinkType -eq 4) {
                    $decision.DecisionLinkType = 7
                }

                $linksRemoved++
            }
        }
    }

    return @{
        CleanedObject = $ProcessObj
        LinksRemoved = $linksRemoved
    }
}

function Remove-InputOutputReferencesFromJson {
    param(
        [string]$ProcessJson,
        [string]$TargetProcessUniqueId
    )

    # Convert JSON string to object
    $processObj = $ProcessJson | ConvertFrom-Json

    $referencesRemoved = 0

    # Remove from Inputs - filter out inputs where FromProcessUniqueId matches target
    if ($processObj.Inputs -and $processObj.Inputs.Input) {
        $originalCount = @($processObj.Inputs.Input).Count
        $processObj.Inputs.Input = @($processObj.Inputs.Input | Where-Object {
            $_.FromProcessUniqueId -ne $TargetProcessUniqueId
        })
        $newCount = @($processObj.Inputs.Input).Count
        $referencesRemoved += ($originalCount - $newCount)

        Write-Host "    Removed $($originalCount - $newCount) input reference(s)" -ForegroundColor Gray
    }

    # Remove from Outputs - filter out outputs where ToProcessUniqueId matches target
    if ($processObj.Outputs -and $processObj.Outputs.Output) {
        $originalCount = @($processObj.Outputs.Output).Count
        $processObj.Outputs.Output = @($processObj.Outputs.Output | Where-Object {
            $_.ToProcessUniqueId -ne $TargetProcessUniqueId
        })
        $newCount = @($processObj.Outputs.Output).Count
        $referencesRemoved += ($originalCount - $newCount)

        Write-Host "    Removed $($originalCount - $newCount) output reference(s)" -ForegroundColor Gray
    }

    # Convert back to JSON string
    $cleanedJson = $processObj | ConvertTo-Json -Depth 20 -Compress

    return @{
        CleanedJson = $cleanedJson
        ReferencesRemoved = $referencesRemoved
    }
}

# Object-based version that works directly with PSObjects (avoids double serialization)
function Remove-InputOutputReferencesFromObject {
    param(
        [object]$ProcessObj,
        [string]$TargetProcessUniqueId
    )

    $referencesRemoved = 0

    # Remove from Inputs - filter out inputs where FromProcessUniqueId matches target
    if ($ProcessObj.Inputs -and $ProcessObj.Inputs.Input) {
        $originalCount = @($ProcessObj.Inputs.Input).Count
        $ProcessObj.Inputs.Input = @($ProcessObj.Inputs.Input | Where-Object {
            $_.FromProcessUniqueId -ne $TargetProcessUniqueId
        })
        $newCount = @($ProcessObj.Inputs.Input).Count
        $referencesRemoved += ($originalCount - $newCount)

        Write-Host "    Removed $($originalCount - $newCount) input reference(s)" -ForegroundColor Gray
    }

    # Remove from Outputs - filter out outputs where ToProcessUniqueId matches target
    if ($ProcessObj.Outputs -and $ProcessObj.Outputs.Output) {
        $originalCount = @($ProcessObj.Outputs.Output).Count
        $ProcessObj.Outputs.Output = @($ProcessObj.Outputs.Output | Where-Object {
            $_.ToProcessUniqueId -ne $TargetProcessUniqueId
        })
        $newCount = @($ProcessObj.Outputs.Output).Count
        $referencesRemoved += ($originalCount - $newCount)

        Write-Host "    Removed $($originalCount - $newCount) output reference(s)" -ForegroundColor Gray
    }

    return @{
        CleanedObject = $ProcessObj
        ReferencesRemoved = $referencesRemoved
    }
}

function Update-ProcessAndPublish {
    param(
        [string]$SiteURL,
        [string]$Token,
        [string]$ProcessUniqueId,
        [string]$TargetProcessUniqueId,
        [bool]$ApprovalsEnabled,
        [string]$DependencyType = "Linked Process"
    )

    try {
        # Step 1: Get current process data
        $getUrl = "$SiteURL/Api/v1/Processes/$ProcessUniqueId"
        $processData = Invoke-ApiGet -Url $getUrl -Token $Token

        if (-not $processData -or -not $processData.processJson) {
            return $false
        }

        # Keep as object for manipulation, convert to JSON string only at the end
        $processObj = $processData.processJson
        $processRevisionEditId = $processObj.ProcessRevisionEditId
        $versionParts = $processObj.Version.Split('.')
        $majorVersion = [int]$versionParts[0]
        $minorVersion = if ($versionParts.Count -gt 1) { [int]$versionParts[1] } else { 0 }
        $wasPreviouslyPublished = $majorVersion -gt 0
        $isInProgress = $minorVersion -gt 0

        # Step 2: Remove ALL types of references from the process object
        # The CheckProcessDependencies API may not accurately report the type (e.g., may report "Linked Process"
        # when the actual reference is in Outputs), so we check ALL locations regardless of reported type
        $totalReferencesRemoved = 0
        $needsPublishOnly = $false

        # Remove from ProcessLinks and Decisions
        $linkResult = Remove-ProcessLinksFromObject -ProcessObj $processObj -TargetProcessUniqueId $TargetProcessUniqueId
        $totalReferencesRemoved += $linkResult.LinksRemoved
        $cleanedProcessObj = $linkResult.CleanedObject

        # Also remove from Inputs and Outputs
        $ioResult = Remove-InputOutputReferencesFromObject -ProcessObj $cleanedProcessObj -TargetProcessUniqueId $TargetProcessUniqueId
        $totalReferencesRemoved += $ioResult.ReferencesRemoved
        $cleanedProcessObj = $ioResult.CleanedObject

        if ($totalReferencesRemoved -eq 0) {
            if ($isInProgress -and $wasPreviouslyPublished) {
                # No references found but process is in-progress - still need to publish to finalize removal
                $needsPublishOnly = $true
            } else {
                return $true
            }
        }

        # Step 3: Update process with cleaned JSON (skip if only publishing)
        if (-not $needsPublishOnly) {
            # ProcessJson must be a JSON string (the API expects a string value, not an object)
            # The string will be properly escaped when the outer body is serialized
            $cleanedJsonString = $cleanedProcessObj | ConvertTo-Json -Depth 20 -Compress

            $updateBody = @{
                ProcessJson = $cleanedJsonString
                ChangeDescription = ""
                DoSubmitForApproval = $false
                DoPublish = $false
                SuppressChangeNotification = $false
                SharedActivityCollectionEditModel = @{
                    ActivitiesToDelete = @()
                    ActivitiesToShare = @()
                    ActivitiesToUnlink = @()
                }
                VariantConnectionChangeStates = @()
            }

            $updateUrl = "$SiteURL/Api/v1/Processes/$ProcessUniqueId"
            $updateResult = Invoke-ApiPut -Url $updateUrl -Token $Token -Body $updateBody

            if (-not $updateResult -or -not $updateResult.Success) {
                return $false
            }
        }

        # Step 4: Publish if needed (or if needsPublishOnly is true)
        if ($wasPreviouslyPublished) {

            # Get current process data to get ProcessRevisionEditId
            Start-Sleep -Seconds 1
            $updatedProcessData = Invoke-ApiGet -Url $getUrl -Token $Token
            $newProcessRevisionEditId = $updatedProcessData.processJson.ProcessRevisionEditId

            if ($ApprovalsEnabled) {
                # Get the updated process JSON string for submission
                $updatedProcessJsonString = $updatedProcessData.processJson | ConvertTo-Json -Depth 20 -Compress

                # Submit for approval
                $submitBody = @{
                    ProcessJson = $updatedProcessJsonString
                    ChangeDescription = "Automated dependency removal"
                    DoSubmitForApproval = $true
                    DoPublish = $false
                    SuppressChangeNotification = $false
                    SharedActivityCollectionEditModel = @{
                        ActivitiesToDelete = @()
                        ActivitiesToShare = @()
                        ActivitiesToUnlink = @()
                    }
                    VariantConnectionChangeStates = @()
                }

                $submitResult = Invoke-ApiPut -Url $updateUrl -Token $Token -Body $submitBody

                if (-not $submitResult -or -not $submitResult.Success) {
                    return $false
                }

                # Wait and get the latest ProcessRevisionEditId after submit
                Start-Sleep -Seconds 2
                $latestProcessData = Invoke-ApiGet -Url $getUrl -Token $Token
                $latestProcessRevisionEditId = $latestProcessData.processJson.ProcessRevisionEditId

                # Bypass approval and publish
                $publishUrl = "$SiteURL/Api/v1/Processes/$ProcessUniqueId/Publish"
                $publishBody = @{
                    ProcessRevisionEditId = $latestProcessRevisionEditId.ToString()
                    IsPublishNow = $true
                }

                $publishResult = Invoke-ApiPost -Url $publishUrl -Token $Token -Body $publishBody

                if ($publishResult) {
                    return $true
                } else {
                    return $false
                }
            }
            else {
                # Publish without approval
                $publishUrl = "$SiteURL/Process/Edit/PublishProcessRevisionEdit"
                $publishBody = @{
                    publishMessage = "Publishing Process"
                    processUniqueId = $ProcessUniqueId
                    processRevisionEditId = [int]$newProcessRevisionEditId
                }

                $publishResult = Invoke-ApiPost -Url $publishUrl -Token $Token -Body $publishBody

                if ($publishResult) {
                    return $true
                } else {
                    return $false
                }
            }
        }
        else {
            return $true
        }
    }
    catch {
        return $false
    }
}

function Get-ArchivedProcessDetails {
    param(
        [string]$SiteURL,
        [string]$Token,
        [array]$ProcessUniqueIds
    )

    Write-Host "  Fetching archived process details using mobile API..." -ForegroundColor Gray

    $processDetails = @()

    # The mobile API can handle multiple processUniqueIds in a single request
    # However, we'll batch them to avoid URL length limits
    $batchSize = 10
    for ($i = 0; $i -lt $ProcessUniqueIds.Count; $i += $batchSize) {
        $batch = $ProcessUniqueIds[$i..[Math]::Min($i + $batchSize - 1, $ProcessUniqueIds.Count - 1)]
        $uniqueIdsParam = $batch -join ","

        $url = "$SiteURL/mobile/api/v1/processes?processUniqueIds=$uniqueIdsParam"
        $response = Invoke-ApiGet -Url $url -Token $Token

        if ($response -and $response.data) {
            $processDetails += $response.data
        }
    }

    return $processDetails
}

function Get-ArchivedProcessesWithReferences {
    param(
        [string]$SiteURL,
        [string]$Token,
        [array]$ProcessIdsToDelete,
        [array]$ArchivedProcesses
    )

    Write-Host "Checking archived processes for references using mobile API..." -ForegroundColor Cyan

    $referencingArchivedProcesses = @()
    $processUniqueIdSet = @{}

    # First, get the unique IDs for the processes to be deleted
    Write-Host "  Getting details for processes to be deleted..." -ForegroundColor Gray
    foreach ($processId in $ProcessIdsToDelete) {
        $getUrl = "$SiteURL/Api/v1/Processes/$processId"
        $process = Invoke-ApiGet -Url $getUrl -Token $Token
        if ($process) {
            $processUniqueIdSet[$process.uniqueId] = $processId
        }
    }

    # Get archived process unique IDs
    $archivedUniqueIds = $ArchivedProcesses | ForEach-Object { $_.processUniqueId }

    # Fetch details for all archived processes using mobile API
    $archivedProcessDetails = Get-ArchivedProcessDetails -SiteURL $SiteURL -Token $Token -ProcessUniqueIds $archivedUniqueIds

    Write-Host "  Scanning $($archivedProcessDetails.Count) archived processes for references..." -ForegroundColor Gray

    foreach ($archivedProcess in $archivedProcessDetails) {
        # Convert to JSON to search for references
        $processJson = $archivedProcess | ConvertTo-Json -Depth 20

        # Check for references to any of the processes being deleted
        $hasReferences = $false
        $referencedProcessIds = @()

        foreach ($uniqueId in $processUniqueIdSet.Keys) {
            if ($processJson -match $uniqueId) {
                $hasReferences = $true
                $referencedProcessIds += $processUniqueIdSet[$uniqueId]
                Write-Host "    Found: Archived process '$($archivedProcess.ProcessModel.Name)' (ID: $($archivedProcess.ProcessModel.Id)) references process with uniqueId: $uniqueId" -ForegroundColor Yellow
            }
        }

        if ($hasReferences) {
            $referencingArchivedProcesses += [PSCustomObject]@{
                ProcessId = $archivedProcess.ProcessModel.Id
                ProcessUniqueId = $archivedProcess.ProcessUniqueId
                ProcessName = $archivedProcess.ProcessModel.Name
                ReferencedProcessIds = $referencedProcessIds
            }
        }
    }

    Write-Host "  Found $($referencingArchivedProcesses.Count) archived processes with references to processes being deleted" -ForegroundColor $(if ($referencingArchivedProcesses.Count -eq 0) { "Green" } else { "Yellow" })

    return $referencingArchivedProcesses
}

function Get-ProcessReferences {
    param(
        [string]$SiteURL,
        [string]$Token,
        [array]$ProcessIdsToDelete,
        [array]$AllProcesses
    )

    Write-Host "Scanning for references to processes to be deleted..." -ForegroundColor Cyan

    $references = @()
    $processIdSet = @{}
    $ProcessIdsToDelete | ForEach-Object { $processIdSet[$_] = $true }

    foreach ($process in $AllProcesses) {
        # Skip processes that are being deleted
        if ($processIdSet.ContainsKey($process.id)) {
            continue
        }

        # Get full process details
        $getUrl = "$SiteURL/Api/v1/Processes/$($process.id)"
        $fullProcess = Invoke-ApiGet -Url $getUrl -Token $Token

        if ($fullProcess) {
            $processJson = $fullProcess | ConvertTo-Json -Depth 10

            # Check for references
            foreach ($deleteId in $ProcessIdsToDelete) {
                if ($processJson -match $deleteId) {
                    $references += [PSCustomObject]@{
                        ReferencingProcessId = $process.id
                        ReferencingProcessName = $process.name
                        ReferencedProcessId = $deleteId
                    }
                    Write-Host "  Found reference: Process $($process.id) '$($process.name)' references Process $deleteId" -ForegroundColor Yellow
                }
            }
        }
    }

    return $references
}

function Remove-ProcessReferences {
    param(
        [string]$SiteURL,
        [string]$Token,
        [array]$References
    )

    Write-Host "`nRemoving references to processes being deleted..." -ForegroundColor Cyan

    $processesUpdated = @{}

    foreach ($ref in $References) {
        if (-not $processesUpdated.ContainsKey($ref.ReferencingProcessId)) {
            Write-Host "Updating Process $($ref.ReferencingProcessId) '$($ref.ReferencingProcessName)'" -ForegroundColor White

            # Get process
            $getUrl = "$SiteURL/Api/v1/Processes/$($ref.ReferencingProcessId)"
            $process = Invoke-ApiGet -Url $getUrl -Token $Token

            if ($process) {
                # Convert to JSON, remove references, convert back
                # This is a simplified approach - you may need more sophisticated logic
                # to properly remove specific references from complex nested structures

                # For now, we'll just log that references exist
                # A full implementation would parse and modify specific fields
                Write-Host "  Warning: Process contains references - manual review may be needed" -ForegroundColor Yellow

                $processesUpdated[$ref.ReferencingProcessId] = $true
            }
        }
    }

    Write-Host "Reference removal scan complete" -ForegroundColor Green
}

function Invoke-BulkDeleteProcesses {
    param(
        [string]$SiteURL,
        [string]$Token,
        [string]$SourceType,  # "CSV", "Group", or "Archived"
        [string]$CsvPath = "",
        [int]$GroupID = -1,
        [string]$GroupUniqueId = "",
        [string]$TempGroupName = "Bulk Delete Temporary Group",
        [string]$CurrentUsername,
        [switch]$WhatIf
    )

    Write-Host "`n========================================" -ForegroundColor Cyan
    if ($WhatIf) {
        Write-Host "BULK DELETE PROCESSES OPERATION (DRY-RUN PREVIEW)" -ForegroundColor Yellow
        Write-Host "========================================" -ForegroundColor Cyan
        Write-Host "*** PREVIEW MODE: No changes will be made ***" -ForegroundColor Yellow
        Write-Host "This preview will show what processes would be deleted." -ForegroundColor Yellow
    } else {
        Write-Host "BULK DELETE PROCESSES OPERATION" -ForegroundColor Cyan
        Write-Host "========================================" -ForegroundColor Cyan
        Write-Host "WARNING: This is a destructive operation!" -ForegroundColor Red
        Write-Host "This will permanently delete processes after removing references." -ForegroundColor Red
    }

    # Ask about process approvals (skip in preview mode)
    if (-not $WhatIf) {
        $approvalsEnabled = (Read-Host "Are process approvals enabled in your environment? (Y/N)") -eq 'Y'
        if ($approvalsEnabled) {
            Write-Host "Process approvals are enabled - this will be considered during dependency removal" -ForegroundColor Yellow
        }

        $confirm = Read-Host "Type 'DELETE' to confirm you want to proceed"
        if ($confirm -ne 'DELETE') {
            Write-Host "Operation cancelled" -ForegroundColor Yellow
            return
        }
    }

    $results = @()
    $processesToDelete = @()
    $documentsToDelete = @()
    $deleteDocuments = $false
    $includeSubgroups = $false

    # Step 1: Gather processes to delete
    Write-Host "`n=== PHASE 1: Gathering Processes ===" -ForegroundColor Cyan

    if ($SourceType -eq "CSV") {
        $csv = Read-CsvWithFlexibleHeaders -Path $CsvPath
        if (-not $csv) { return }

        foreach ($row in $csv) {
            $id = Get-IdFromCsvRow -Row $row
            if ($id) {
                $processesToDelete += $id
            }
        }
    }
    elseif ($SourceType -eq "Archived") {
        # Fetch all archived processes
        Write-Host "Fetching all archived processes from the site..." -ForegroundColor Yellow
        $processesToDelete = Get-AllArchivedProcesses -SiteURL $SiteURL -Token $Token

        if ($processesToDelete.Count -eq 0) {
            Write-Host "No archived processes found in the site" -ForegroundColor Yellow
            return
        }
    }
    else {  # Group-based
        $includeSubgroups = (Read-Host "Include subgroups? (Y/N)") -eq 'Y'
        $deleteDocuments = (Read-Host "Also delete documents from this group? (Y/N)") -eq 'Y'

        $processes = Get-ProcessesFromGroup -SiteURL $SiteURL -Token $Token -GroupID $GroupID -GroupUniqueId $GroupUniqueId -IncludeSubgroups $includeSubgroups
        $processesToDelete = $processes | ForEach-Object { $_.processUniqueId }

        # If deleting documents, fetch them now
        if ($deleteDocuments) {
            $documents = Get-DocumentsFromGroup -SiteURL $SiteURL -Token $Token -GroupUniqueId $GroupUniqueId -IncludeSubgroups $includeSubgroups
            $documentsToDelete = $documents
        }
    }

    Write-Host "Identified $($processesToDelete.Count) processes to delete" -ForegroundColor Green

    # Check if there's anything to delete
    if ($processesToDelete.Count -eq 0 -and $documentsToDelete.Count -eq 0) {
        Write-Host "No processes or documents to delete" -ForegroundColor Yellow
        return
    }

    if ($processesToDelete.Count -eq 0) {
        Write-Host "No processes to delete - skipping process deletion phases" -ForegroundColor Yellow
        # Skip to document deletion phase (after PHASE 8)
    }

    # Step 1.5: Get unique IDs and numeric IDs for all processes to delete
    if ($processesToDelete.Count -gt 0) {
        Write-Host "`n=== Getting Process Details ===" -ForegroundColor Cyan

    $processDeleteMap = @{}  # Maps any ID to object with {NumericId, UniqueId, GroupUniqueId, Name}

    # Special handling for archived processes - use mobile API endpoint
    if ($SourceType -eq "Archived") {
        # For archived processes, use the mobile API to batch-fetch details
        Write-Host "  Fetching archived process details using mobile API..." -ForegroundColor Gray

        $batchSize = 10
        $totalProcesses = $processesToDelete.Count
        $processedCount = 0

        for ($i = 0; $i -lt $processesToDelete.Count; $i += $batchSize) {
            $endIndex = [Math]::Min($i + $batchSize - 1, $processesToDelete.Count - 1)
            $batch = $processesToDelete[$i..$endIndex]
            $uniqueIdsParam = $batch -join ","

            $processedCount += $batch.Count
            Write-Host "`r  Getting Process Details $processedCount out of $totalProcesses..." -NoNewline -ForegroundColor Gray

            $url = "$SiteURL/mobile/api/v1/processes?processUniqueIds=$uniqueIdsParam"
            $response = Invoke-ApiGet -Url $url -Token $Token

            if ($response -and $response.data) {
                foreach ($processData in $response.data) {
                    if ($processData.ProcessModel) {
                        $model = $processData.ProcessModel
                        $processDeleteMap[$model.UniqueId] = @{
                            NumericId = $model.Id
                            UniqueId = $model.UniqueId
                            GroupUniqueId = $model.GroupUniqueId
                            Name = $model.Name
                        }
                    }
                }
            }
        }
        Write-Host ""  # New line after progress counter
    }
    else {
        # For non-archived processes, use the regular API endpoint
        $currentIndex = 0
        $totalProcesses = $processesToDelete.Count

        foreach ($processId in $processesToDelete) {
            $currentIndex++
            Write-Host "`r  Getting Process Details $currentIndex out of $totalProcesses..." -NoNewline -ForegroundColor Gray

            # Check if the ID is already a GUID (UniqueId) or a numeric ID
            $guidRegex = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

            if ($processId -match $guidRegex) {
                # It's already a UniqueId (GUID format), need to fetch numeric ID and group info
                $processStatus = Get-ProcessStatus -SiteURL $SiteURL -Token $Token -ProcessUniqueId $processId
                if ($processStatus) {
                    $numericId = $processStatus.Id
                    $groupUniqueId = if ($processStatus.GroupUniqueId) {
                        $processStatus.GroupUniqueId
                    } else {
                        $null
                    }
                    $processDeleteMap[$processId] = @{
                        NumericId = $numericId
                        UniqueId = $processId
                        GroupUniqueId = $groupUniqueId
                        Name = $processStatus.Name
                    }
                } else {
                    Write-Host "`n  Warning: Could not retrieve process details for UniqueId $processId" -ForegroundColor Yellow
                }
            } else {
                # It's a numeric ID, fetch the process to get the UniqueId and group info
                $getUrl = "$SiteURL/Api/v1/Processes/$processId"
                $process = Invoke-ApiGet -Url $getUrl -Token $Token
                if ($process -and $process.uniqueId) {
                    # Get the process status to retrieve group information
                    $processStatus = Get-ProcessStatus -SiteURL $SiteURL -Token $Token -ProcessUniqueId $process.uniqueId
                    $groupUniqueId = if ($processStatus -and $processStatus.GroupUniqueId) {
                        $processStatus.GroupUniqueId
                    } else {
                        $null
                    }
                    $processDeleteMap[$processId] = @{
                        NumericId = $processId
                        UniqueId = $process.uniqueId
                        GroupUniqueId = $groupUniqueId
                        Name = if ($processStatus) { $processStatus.Name } else { $null }
                    }
                    Write-Host "  Process ID $processId -> UniqueId: $($process.uniqueId), GroupUniqueId: $groupUniqueId" -ForegroundColor Gray
                } else {
                    Write-Host "  Warning: Could not retrieve process details for ID $processId" -ForegroundColor Yellow
                }
            }
        }
        Write-Host ""  # New line after progress counter
    }

    # PREVIEW MODE: Exit early with summary
    if ($WhatIf) {
        Write-Host ""
        Write-Host "=== PREVIEW SUMMARY ===" -ForegroundColor Yellow
        Write-Host "Total processes that would be deleted: $($processDeleteMap.Keys.Count)" -ForegroundColor Cyan

        # Generate preview results
        foreach ($processKey in $processDeleteMap.Keys) {
            $processInfo = $processDeleteMap[$processKey]
            $results += [PSCustomObject]@{
                ObjectType = "Process"
                ObjectID = $processInfo.NumericId
                ProcessUniqueId = $processInfo.UniqueId
                GroupUniqueId = $processInfo.GroupUniqueId
                Operation = "Delete"
                Status = "Preview"
                Message = "Would be deleted (after dependency removal, archiving, etc.)"
            }
        }

        # Add document previews if applicable
        if ($documentsToDelete.Count -gt 0) {
            Write-Host "Total documents that would be deleted: $($documentsToDelete.Count)" -ForegroundColor Cyan

            foreach ($doc in $documentsToDelete) {
                $results += [PSCustomObject]@{
                    ObjectType = "Document"
                    ObjectID = $doc.id
                    ProcessUniqueId = ""
                    GroupUniqueId = ""
                    Operation = "Delete"
                    Status = "Preview"
                    Message = "Would be deleted"
                }
            }
        }

        # Preview: Show groups that could be deleted (if Group source type)
        if ($SourceType -eq "Group" -and $GroupUniqueId) {
            Write-Host ""
            Write-Host "=== OPTIONAL GROUP DELETION ===" -ForegroundColor Yellow
            Write-Host "If you choose to delete group folders after process/document deletion:" -ForegroundColor Cyan

            $groupsToDelete = Get-GroupsInTree -SiteURL $SiteURL -Token $Token -RootGroupUniqueId $GroupUniqueId -IncludeRoot $true

            if ($groupsToDelete.Count -gt 0) {
                Write-Host "The following $($groupsToDelete.Count) group(s) would be deleted (bottom to top):" -ForegroundColor Cyan
                foreach ($grp in $groupsToDelete) {
                    $indent = "  " * $grp.Depth
                    Write-Host "$indent- $($grp.Name) (Depth: $($grp.Depth))" -ForegroundColor Gray

                    $results += [PSCustomObject]@{
                        ObjectType = "ProcessGroup (Optional)"
                        ObjectID = $grp.UniqueId
                        ProcessUniqueId = ""
                        GroupUniqueId = $grp.UniqueId
                        Operation = "Delete"
                        Status = "Preview"
                        Message = "Would be deleted if group cleanup is selected (Depth: $($grp.Depth), Name: $($grp.Name))"
                    }
                }
            }
        }

        # Save preview results
        $timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
        $outputPath = "Delete_Preview_$timestamp.csv"
        $results | Export-Csv -Path $outputPath -NoTypeInformation

        Write-Host ""
        Write-Host "Preview results saved to: $outputPath" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "NOTE: This preview shows what would be deleted." -ForegroundColor Yellow
        Write-Host "The actual delete operation includes:" -ForegroundColor Yellow
        Write-Host "  - Checking and removing all process dependencies" -ForegroundColor Gray
        Write-Host "  - Creating temporary group for dependency restoration" -ForegroundColor Gray
        Write-Host "  - Changing ownership to current user" -ForegroundColor Gray
        Write-Host "  - Archiving all processes" -ForegroundColor Gray
        Write-Host "  - Permanent deletion" -ForegroundColor Gray
        Write-Host "  - Cleanup of temporary groups" -ForegroundColor Gray
        if ($SourceType -eq "Group") {
            Write-Host "  - Optional: Delete process group folders (you will be prompted)" -ForegroundColor Gray
        }
        Write-Host ""
        Write-Host "*** This was a PREVIEW - no changes were made ***" -ForegroundColor Yellow
        return
    }

    # Step 2: Check dependencies for each process (active and archived)
    Write-Host "`n=== PHASE 2: Checking Dependencies ===" -ForegroundColor Cyan

    $allDependencies = @()  # Array to store all dependencies
    # WRONG: deduplicating by Type|UniqueId discards the occurrence count, which is
    # exactly the number of reference sites that have to be cleared. A process referenced
    # three times collapses to one entry and two references survive the removal.
    # See API_ARCHITECTURE.md, "Counts are per-occurrence".
    $dependencyMap = @{}    # Map to track unique dependencies by UniqueId

    # Part 1: Check active process dependencies
    Write-Host "Checking active process dependencies..." -ForegroundColor Gray
    $currentIndex = 0
    $totalProcesses = $processDeleteMap.Keys.Count
    $groupDependencies = @()  # Track group dependencies for separate file

    foreach ($processKey in $processDeleteMap.Keys) {
        $currentIndex++
        Write-Host "`r  Getting Process Dependencies $currentIndex out of $totalProcesses..." -NoNewline -ForegroundColor Gray

        $processInfo = $processDeleteMap[$processKey]
        $processUniqueId = $processInfo.UniqueId
        $processNumericId = $processInfo.NumericId

        $dependencies = Get-ProcessDependencies -SiteURL $SiteURL -Token $Token -ProcessUniqueId $processUniqueId

        if ($dependencies -and $dependencies.Count -gt 0) {
            foreach ($depType in $dependencies) {
                $typeName = $depType.Type

                foreach ($dep in $depType.Dependencies) {
                    $depUniqueId = $dep.UniqueId
                    $depName = $dep.Name

                    # Create a unique key for this dependency
                    $depKey = "$typeName|$depUniqueId"

                    # Track which processes reference this dependency
                    if (-not $dependencyMap.ContainsKey($depKey)) {
                        $dependencyMap[$depKey] = @{
                            Type = $typeName
                            UniqueId = $depUniqueId
                            Name = $depName
                            ReferencedByProcesses = @()
                        }
                    }

                    # Add the current process to the list of processes that reference this dependency
                    if ($dependencyMap[$depKey].ReferencedByProcesses -notcontains $processKey) {
                        $dependencyMap[$depKey].ReferencedByProcesses += $processKey
                    }

                    # Track group dependencies for export to file
                    if ($typeName -eq "Linked Process Group") {
                        $groupDependencies += [PSCustomObject]@{
                            ProcessID = $processNumericId
                            ProcessUniqueId = $processUniqueId
                            ProcessName = $processInfo.Name
                            GroupName = $depName
                            GroupUniqueId = $depUniqueId
                        }
                    }
                }
            }
        }
    }
    Write-Host ""  # New line after progress counter

    # Part 1.5: WRONG AS WRITTEN. Part 1 above and this part call the SAME endpoint on
    # the SAME processes, then interpret the result as outgoing in one place and incoming
    # in the other. The endpoint is bidirectional and does not distinguish the two, so
    # neither reading is correct and the two passes duplicate each other.
    # See API_ARCHITECTURE.md, "Dependency Checking APIs".
    Write-Host "`nChecking active process incoming dependencies..." -ForegroundColor Gray
    Write-Host "  NOTE: Searching all active processes for references to the target processes..." -ForegroundColor DarkGray

    $activeDependencies = Get-ActiveProcessDependencies -SiteURL $SiteURL -Token $Token -ProcessDeleteMap $processDeleteMap

    if ($activeDependencies.Count -gt 0) {
        # Add active dependencies to the dependencyMap (deduplicates by Type|UniqueId)
        $addedCount = 0
        foreach ($activeDep in $activeDependencies) {
            $depKey = "$($activeDep.Type)|$($activeDep.UniqueId)"

            if (-not $dependencyMap.ContainsKey($depKey)) {
                $dependencyMap[$depKey] = @{
                    Type = $activeDep.Type
                    UniqueId = $activeDep.UniqueId
                    Name = $activeDep.Name
                    ReferencedByProcesses = @()
                    IsArchived = $false
                }
                $addedCount++
            }

            # Add the process key that this active process references
            if ($dependencyMap[$depKey].ReferencedByProcesses -notcontains $activeDep.ReferencedProcessKey) {
                $dependencyMap[$depKey].ReferencedByProcesses += $activeDep.ReferencedProcessKey
            }
        }

        # Get unique processes from the active dependencies
        $uniqueProcesses = $activeDependencies | Select-Object -Property UniqueId, Name -Unique

        Write-Host "  Found $($uniqueProcesses.Count) active process(es) with $addedCount unique dependency type(s)" -ForegroundColor Yellow
        foreach ($proc in $uniqueProcesses) {
            # Count how many dependency types this process has
            $procDepTypes = $activeDependencies | Where-Object { $_.UniqueId -eq $proc.UniqueId } | Select-Object -Property Type -Unique
            Write-Host "    - [Active] $($proc.Name) ($($proc.UniqueId)) - $($procDepTypes.Count) dependency type(s)" -ForegroundColor Gray
        }
    } else {
        Write-Host "  No active process dependencies found" -ForegroundColor Green
    }

    # Part 2: Check archived process dependencies
    Write-Host "`nChecking archived process incoming dependencies..." -ForegroundColor Gray
    Write-Host "  NOTE: Searching all archived processes for references to the target processes..." -ForegroundColor DarkGray

    $archivedDependencies = Get-ArchivedProcessDependencies -SiteURL $SiteURL -Token $Token -ProcessDeleteMap $processDeleteMap

    if ($archivedDependencies.Count -gt 0) {
        # Add archived dependencies to the dependencyMap (deduplicates by Type|UniqueId)
        $addedCount = 0
        foreach ($archivedDep in $archivedDependencies) {
            $depKey = "$($archivedDep.Type)|$($archivedDep.UniqueId)"

            if (-not $dependencyMap.ContainsKey($depKey)) {
                $dependencyMap[$depKey] = @{
                    Type = $archivedDep.Type
                    UniqueId = $archivedDep.UniqueId
                    Name = $archivedDep.Name
                    ReferencedByProcesses = @()
                    IsArchived = $true
                }
                $addedCount++
            }

            # Add the process key that this archived process references
            if ($dependencyMap[$depKey].ReferencedByProcesses -notcontains $archivedDep.ReferencedProcessKey) {
                $dependencyMap[$depKey].ReferencedByProcesses += $archivedDep.ReferencedProcessKey
            }
        }

        # Get unique processes from the archived dependencies
        $uniqueProcesses = $archivedDependencies | Select-Object -Property UniqueId, Name -Unique

        Write-Host "  Found $($uniqueProcesses.Count) archived process(es) with $addedCount unique dependency type(s)" -ForegroundColor Yellow
        foreach ($proc in $uniqueProcesses) {
            # Count how many dependency types this process has
            $procDepTypes = $archivedDependencies | Where-Object { $_.UniqueId -eq $proc.UniqueId } | Select-Object -Property Type -Unique
            Write-Host "    - [Archived] $($proc.Name) ($($proc.UniqueId)) - $($procDepTypes.Count) dependency type(s)" -ForegroundColor Gray
        }
    } else {
        Write-Host "  No archived process dependencies found" -ForegroundColor Green
    }

    # Display summary of all dependencies (active and archived)
    Write-Host "`n=== Dependency Summary ===" -ForegroundColor Cyan
    if ($dependencyMap.Count -eq 0) {
        Write-Host "No dependencies found - processes can be deleted directly" -ForegroundColor Green
    } else {
        # Export dependencies to CSV file
        $timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
        $dependenciesFile = "Dependencies_$timestamp.csv"

        $dependencyExport = @()
        foreach ($depKey in $dependencyMap.Keys) {
            $dep = $dependencyMap[$depKey]
            $refCount = $dep.ReferencedByProcesses.Count

            # Get list of processes that reference this dependency
            $referencingProcesses = $dep.ReferencedByProcesses -join "; "

            $dependencyExport += [PSCustomObject]@{
                Type = $dep.Type
                Name = $dep.Name
                UniqueId = $dep.UniqueId
                IsArchived = $dep.IsArchived
                ReferencedByCount = $refCount
                ReferencingProcesses = $referencingProcesses
            }
        }

        $dependencyExport | Export-Csv -Path $dependenciesFile -NoTypeInformation

        $archivedCount = ($dependencyMap.Values | Where-Object { $_.IsArchived -eq $true }).Count

        Write-Host "Found $($dependencyMap.Count) unique dependencies" -ForegroundColor Yellow
        if ($archivedCount -gt 0) {
            Write-Host "  ($archivedCount will be temporarily restored for link removal)" -ForegroundColor Cyan
        }
        Write-Host "Dependencies exported to: $dependenciesFile" -ForegroundColor Cyan

        $proceed = Read-Host "`nDo you want to proceed with dependency removal? (Y/N)"
        if ($proceed -ne 'Y') {
            Write-Host "Operation cancelled by user" -ForegroundColor Yellow
            return
        }
    }

    # Step 3: Create temporary group for restoring archived dependencies (only if needed)
    $tempGroupCreated = $false
    $tempGroupId = $null
    $tempGroupUniqueId = $null

    if ($archivedCount -gt 0) {
        Write-Host "`n=== PHASE 3: Creating Temporary Group ===" -ForegroundColor Cyan

        $tempGroup = New-ProcessGroup -SiteURL $SiteURL -Token $Token -GroupName $TempGroupName

        if (-not $tempGroup -or -not $tempGroup.id -or $tempGroup.id -lt 0) {
            Write-Host "Failed to create temporary group. Operation cancelled." -ForegroundColor Red
            return
        }

        $tempGroupId = $tempGroup.id
        $tempGroupUniqueId = $tempGroup.uniqueId
        $tempGroupCreated = $true
        Write-Host "Temporary group created (ID: $tempGroupId, uniqueId: $tempGroupUniqueId)" -ForegroundColor Green
    } else {
        Write-Host "`n=== PHASE 3: Creating Temporary Group ===" -ForegroundColor Cyan
        Write-Host "No archived dependencies found - skipping temporary group creation" -ForegroundColor Green
    }

    # Step 4: Check status of each dependency and restore if needed
    Write-Host "`n=== PHASE 4: Checking Dependency Status and Restoring Archived Dependencies ===" -ForegroundColor Cyan

    $restoredDependencies = @()  # Track which dependencies were restored

    foreach ($depKey in $dependencyMap.Keys) {
        $dep = $dependencyMap[$depKey]

        # NOTE: this incoming/outgoing split is not real. CheckProcessDependencies
        # returns both directions in one undifferentiated list.
        # See API_ARCHITECTURE.md, "Dependency Checking APIs".
        # We only need to restore processes that REFERENCE the targets being deleted, not processes REFERENCED BY the targets
        if ($dep.IsArchived -eq $true) {
            Write-Host "Checking status of dependency: $($dep.Name) ($($dep.UniqueId))" -ForegroundColor White

            $processStatus = Get-ProcessStatus -SiteURL $SiteURL -Token $Token -ProcessUniqueId $dep.UniqueId

            if ($processStatus) {
                $state = $processStatus.State
                $numericId = $processStatus.Id

                Write-Host "  Status: $state (Numeric ID: $numericId)" -ForegroundColor Gray

                if ($state -eq "Archived") {
                    Write-Host "  Process is archived - restoring to temporary group..." -ForegroundColor Yellow

                    $restoreUrl = "$SiteURL/Process/Edit/RestoreProcess"
                    $restoreBody = @{
                        processUniqueId = $dep.UniqueId
                        processGroupId = $tempGroupId.ToString()
                    }
                    $result = Invoke-ApiPost -Url $restoreUrl -Token $Token -Body $restoreBody

                    if ($result) {
                        Write-Host "  Successfully restored to temporary group" -ForegroundColor Green
                        $restoredDependencies += @{
                            UniqueId = $dep.UniqueId
                            NumericId = $numericId
                            Name = $dep.Name
                        }
                    } else {
                        Write-Host "  Failed to restore process" -ForegroundColor Red
                    }
                } else {
                    Write-Host "  Process is active - no restore needed" -ForegroundColor Green
                }
            } else {
                Write-Host "  Could not retrieve process status" -ForegroundColor Red
            }
        }
    }

    Write-Host "`nRestored $($restoredDependencies.Count) archived dependencies to temporary group" -ForegroundColor Green

    # Step 5: Remove dependencies
    Write-Host "`n=== PHASE 5: Removing Dependencies ===" -ForegroundColor Cyan

    if ($dependencyMap.Count -eq 0) {
        Write-Host "No dependencies to remove - skipping this phase" -ForegroundColor Green
    } else {
        # Separate dependencies by type
        $automaticDeps = @()
        $manualDeps = @()

        foreach ($depKey in $dependencyMap.Keys) {
            $dep = $dependencyMap[$depKey]
            # Automatic removal: Linked Process, Process Input, Process Output
            if ($dep.Type -eq "Linked Process" -or $dep.Type -eq "Process Input" -or $dep.Type -eq "Process Output") {
                $automaticDeps += $dep
            }
            else {
                # All other dependencies (including Linked Process Group) require manual removal
                $manualDeps += $dep
            }
        }

        # Handle automatic removal of dependencies (Linked Process, Process Input, Process Output)
        if ($automaticDeps.Count -gt 0) {
            Write-Host "`n--- Removing Dependencies (Automatic) ---" -ForegroundColor Cyan

            $dependenciesProcessed = 0
            $dependenciesSuccessful = 0
            $dependenciesFailed = 0
            $totalDependencies = $automaticDeps.Count

            foreach ($dep in $automaticDeps) {
                $dependenciesProcessed++
                Write-Host "`r  Removing Dependencies $dependenciesProcessed out of $totalDependencies..." -NoNewline -ForegroundColor Gray

                # Get all processes being deleted that reference this dependency
                $processesToRemoveFrom = $dep.ReferencedByProcesses

                # For each process being deleted that references this dependency
                foreach ($processIdToDelete in $processesToRemoveFrom) {
                    $processInfo = $processDeleteMap[$processIdToDelete]
                    $processUniqueIdToDelete = $processInfo.UniqueId

                    $success = Update-ProcessAndPublish -SiteURL $SiteURL -Token $Token `
                        -ProcessUniqueId $dep.UniqueId `
                        -TargetProcessUniqueId $processUniqueIdToDelete `
                        -ApprovalsEnabled $approvalsEnabled `
                        -DependencyType $dep.Type

                    if ($success) {
                        $dependenciesSuccessful++
                    } else {
                        $dependenciesFailed++
                    }

                    # Small delay between updates
                    Start-Sleep -Milliseconds 500
                }
            }
            Write-Host ""  # New line after progress counter

            Write-Host "`n=== Automatic Dependency Removal Summary ===" -ForegroundColor Cyan
            Write-Host "Total dependencies processed: $dependenciesProcessed" -ForegroundColor White
            Write-Host "Successful: $dependenciesSuccessful" -ForegroundColor Green
            Write-Host "Failed: $dependenciesFailed" -ForegroundColor $(if ($dependenciesFailed -gt 0) { "Red" } else { "Green" })

            if ($dependenciesFailed -gt 0) {
                $continueAnyway = Read-Host "`nSome dependencies failed to update. Do you want to continue? (Y/N)"
                if ($continueAnyway -ne 'Y') {
                    Write-Host "Operation cancelled. Restored dependencies remain in temporary group for manual cleanup." -ForegroundColor Yellow
                    return
                }
            }
        }

        # Handle manual removal dependencies (includes Linked Process Group and other types)
        if ($manualDeps.Count -gt 0) {
            # Separate group dependencies from other manual dependencies
            $groupDeps = $manualDeps | Where-Object { $_.Type -eq "Linked Process Group" }
            $otherManualDeps = $manualDeps | Where-Object { $_.Type -ne "Linked Process Group" }

            # Export group dependencies to file if any exist
            if ($groupDeps.Count -gt 0) {
                $timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
                $groupDepsFile = "Group_Dependencies_$timestamp.csv"

                $groupDepExport = @()
                foreach ($groupDep in $groupDependencies) {
                    $groupDepExport += $groupDep
                }

                if ($groupDepExport.Count -gt 0) {
                    $groupDepExport | Export-Csv -Path $groupDepsFile -NoTypeInformation
                    Write-Host "`nGroup dependencies exported to: $groupDepsFile" -ForegroundColor Cyan
                    Write-Host "  Found $($groupDepExport.Count) group dependencies that must be manually removed" -ForegroundColor Yellow
                }
            }

            # Only display non-group manual dependencies in console
            if ($otherManualDeps.Count -gt 0) {
                Write-Host "`n--- Manual Dependency Removal Required ---" -ForegroundColor Yellow
                Write-Host "The following dependencies require MANUAL removal:" -ForegroundColor Yellow
                Write-Host ""

                # Group manual dependencies by the processes being deleted
                $manualDepsByProcess = @{}
                foreach ($dep in $otherManualDeps) {
                    foreach ($processIdToDelete in $dep.ReferencedByProcesses) {
                        if (-not $manualDepsByProcess.ContainsKey($processIdToDelete)) {
                            $manualDepsByProcess[$processIdToDelete] = @()
                        }
                        $manualDepsByProcess[$processIdToDelete] += $dep
                    }
                }

                # Display dependencies grouped by process
                foreach ($processIdToDelete in $manualDepsByProcess.Keys) {
                    $processInfo = $processDeleteMap[$processIdToDelete]
                    $processUniqueIdToDelete = $processInfo.UniqueId
                    $deps = $manualDepsByProcess[$processIdToDelete]

                    Write-Host "Process to be deleted: ID $processIdToDelete (UniqueId: $processUniqueIdToDelete)" -ForegroundColor White
                    Write-Host "  Has the following dependencies that must be manually removed:" -ForegroundColor Yellow

                    foreach ($dep in $deps) {
                        Write-Host "    - Type: $($dep.Type)" -ForegroundColor Cyan
                        Write-Host "      Name: $($dep.Name)" -ForegroundColor Cyan
                        Write-Host "      UniqueId: $($dep.UniqueId)" -ForegroundColor Cyan
                        Write-Host ""
                    }
                }
            } else {
                # Only group dependencies - update the manual deps list to empty so we don't prompt
                $manualDepsByProcess = @{}
            }

            Write-Host "========================================" -ForegroundColor Yellow
            Write-Host "ACTION REQUIRED:" -ForegroundColor Red
            Write-Host "Please manually remove the dependencies listed above from Nintex Process Manager." -ForegroundColor Yellow
            Write-Host "The script will wait until you confirm they have been removed." -ForegroundColor Yellow
            Write-Host "========================================" -ForegroundColor Yellow
            Write-Host ""

            # Wait for user confirmation
            $manualRemovalComplete = $false
            while (-not $manualRemovalComplete) {
                $userConfirm = Read-Host "Have you manually removed all the dependencies listed above? (Y/N/Cancel)"

                if ($userConfirm -eq 'Cancel') {
                    Write-Host "Operation cancelled by user. Restored dependencies remain in temporary group for manual cleanup." -ForegroundColor Yellow
                    return
                }
                elseif ($userConfirm -eq 'Y') {
                    # Validate that dependencies have been removed
                    Write-Host "`nValidating that dependencies have been removed..." -ForegroundColor Cyan

                    $validationFailed = $false
                    foreach ($processId in $manualDepsByProcess.Keys) {
                        $processInfo = $processDeleteMap[$processId]
                        $processUniqueId = $processInfo.UniqueId
                        Write-Host "  Checking process $processId..." -ForegroundColor Gray

                        $currentDeps = Get-ProcessDependencies -SiteURL $SiteURL -Token $Token -ProcessUniqueId $processUniqueId

                        # Check if any of the manual dependencies still exist
                        $stillHasDeps = $false
                        if ($currentDeps -and $currentDeps.Count -gt 0) {
                            foreach ($depType in $currentDeps) {
                                # Skip automatically handled types: Linked Process, Process Input, Process Output
                                # Include Linked Process Group and other types since they require manual removal
                                if ($depType.Type -ne "Linked Process" -and $depType.Type -ne "Process Input" -and $depType.Type -ne "Process Output") {
                                    if ($depType.Dependencies -and $depType.Dependencies.Count -gt 0) {
                                        $stillHasDeps = $true
                                        Write-Host "    WARNING: Process still has $($depType.Dependencies.Count) dependencies of type '$($depType.Type)'" -ForegroundColor Red
                                        foreach ($dep in $depType.Dependencies) {
                                            Write-Host "      - $($dep.Name) ($($dep.UniqueId))" -ForegroundColor Red
                                        }
                                    }
                                }
                            }
                        }

                        if ($stillHasDeps) {
                            $validationFailed = $true
                        } else {
                            Write-Host "    Process validated - no manual dependencies remaining" -ForegroundColor Green
                        }
                    }

                    if ($validationFailed) {
                        Write-Host "`nValidation failed: Some dependencies still exist." -ForegroundColor Red
                        Write-Host "Please remove all dependencies before continuing." -ForegroundColor Yellow
                    } else {
                        Write-Host "`nValidation successful: All manual dependencies have been removed!" -ForegroundColor Green
                        $manualRemovalComplete = $true
                    }
                }
                else {
                    Write-Host "Please remove the dependencies and then enter 'Y' to continue, or 'Cancel' to abort." -ForegroundColor Yellow
                }
            }

            Write-Host "`nManual dependency removal completed successfully." -ForegroundColor Green
        }

        Write-Host "`n=== All Dependencies Processed ===" -ForegroundColor Green
    }

    # Step 5.5: Pre-archive verification - recheck dependency API to ensure all dependencies were removed
    Write-Host "`n=== PHASE 5.5: Verifying Dependency Removal ===" -ForegroundColor Cyan
    Write-Host "Re-checking dependency API to verify all references have been removed..." -ForegroundColor Gray

    $verificationFailed = $false
    $remainingDependencies = @()
    $totalChecked = 0
    $totalTargets = $processDeleteMap.Keys.Count

    foreach ($processKey in $processDeleteMap.Keys) {
        $totalChecked++
        $processInfo = $processDeleteMap[$processKey]
        $targetUniqueId = $processInfo.UniqueId
        $targetName = $processInfo.Name

        Write-Host "`r  Verifying process $totalChecked of $totalTargets..." -NoNewline -ForegroundColor Gray

        try {
            $url = "$SiteURL/Api/v1/Processes/$targetUniqueId/CheckProcessDependencies?searchBehavior=15"
            $dependencies = Invoke-ApiGet -Url $url -Token $Token

            if ($dependencies) {
                $depArray = @()
                if ($dependencies -is [Array]) {
                    $depArray = $dependencies
                } else {
                    $depArray = @($dependencies)
                }

                foreach ($depType in $depArray) {
                    $typeName = $depType.Type
                    # Check for any automatic dependency types that should have been removed
                    if (($typeName -eq "Linked Process" -or $typeName -eq "Process Input" -or $typeName -eq "Process Output") -and $depType.Dependencies -and $depType.Dependencies.Count -gt 0) {
                        $verificationFailed = $true
                        Write-Host ""
                        Write-Host "    WARNING: Process '$targetName' still has $($depType.Dependencies.Count) '$typeName' dependencies:" -ForegroundColor Red
                        foreach ($dep in $depType.Dependencies) {
                            Write-Host "      - $($dep.Name) ($($dep.UniqueId))" -ForegroundColor Red
                            $remainingDependencies += @{
                                TargetProcess = $targetName
                                TargetUniqueId = $targetUniqueId
                                DependencyType = $typeName
                                DependencyName = $dep.Name
                                DependencyUniqueId = $dep.UniqueId
                            }
                        }
                        Write-Host "`r  Verifying process $totalChecked of $totalTargets..." -NoNewline -ForegroundColor Gray
                    }
                }
            }
        }
        catch {
            Write-Host ""
            Write-Host "    Warning: Failed to verify dependencies for process $targetUniqueId : $($_.Exception.Message)" -ForegroundColor Yellow
            Write-Host "`r  Verifying process $totalChecked of $totalTargets..." -NoNewline -ForegroundColor Gray
        }
    }
    Write-Host ""  # New line after progress indicator

    if ($verificationFailed) {
        Write-Host "`n=== VERIFICATION FAILED ===" -ForegroundColor Red
        Write-Host "The following dependencies were NOT successfully removed:" -ForegroundColor Red
        Write-Host ""

        # Group by target process
        $groupedDeps = $remainingDependencies | Group-Object -Property TargetProcess
        foreach ($group in $groupedDeps) {
            Write-Host "  Target: $($group.Name)" -ForegroundColor Yellow
            foreach ($dep in $group.Group) {
                Write-Host "    - [$($dep.DependencyType)] $($dep.DependencyName) ($($dep.DependencyUniqueId))" -ForegroundColor Red
            }
        }

        Write-Host ""
        Write-Host "These dependencies must be removed before archiving/deleting." -ForegroundColor Yellow
        $continueAnyway = Read-Host "Do you want to continue anyway? (Y/N)"
        if ($continueAnyway -ne 'Y') {
            Write-Host "Operation cancelled. Please manually remove the remaining dependencies and try again." -ForegroundColor Yellow
            return
        }
        Write-Host "Continuing despite remaining dependencies..." -ForegroundColor Yellow
    } else {
        Write-Host "Verification successful: All automatic dependencies have been removed!" -ForegroundColor Green
    }

    # Step 6: Archive processes (skipping ownership update as it's not needed with bypass approvals)
    Write-Host "`n=== PHASE 6: Archiving Processes ===" -ForegroundColor Cyan

    $currentIndex = 0
    $totalProcesses = $processDeleteMap.Keys.Count

    foreach ($processKey in $processDeleteMap.Keys) {
        $processInfo = $processDeleteMap[$processKey]
        $processNumericId = $processInfo.NumericId
        $processUniqueId = $processInfo.UniqueId

        $currentIndex++
        Write-Host "`r  Archiving $currentIndex out of $totalProcesses..." -NoNewline -ForegroundColor Gray

        # Check if process is already archived
        $processStatus = Get-ProcessStatus -SiteURL $SiteURL -Token $Token -ProcessUniqueId $processUniqueId

        if ($processStatus -and $processStatus.State -ne "Archived") {
            Archive-Process -SiteURL $SiteURL -Token $Token -ProcessUniqueId $processUniqueId -Comment "Pre-delete archive" | Out-Null
        }
    }
    Write-Host ""  # New line after progress counter

    # Step 7: Delete processes
    Write-Host "`n=== PHASE 7: Deleting Processes ===" -ForegroundColor Cyan

    $confirm = Read-Host "Ready to PERMANENTLY DELETE processes. Type 'DELETE' to confirm"
    if ($confirm -ne 'DELETE') {
        Write-Host "Operation cancelled" -ForegroundColor Yellow
        return
    }

    $currentIndex = 0
    $totalProcesses = $processDeleteMap.Keys.Count

    foreach ($processKey in $processDeleteMap.Keys) {
        $processInfo = $processDeleteMap[$processKey]
        $processNumericId = $processInfo.NumericId
        $processUniqueId = $processInfo.UniqueId
        $processGroupUniqueId = $processInfo.GroupUniqueId

        $currentIndex++
        Write-Host "`r  Deleting $currentIndex out of $totalProcesses..." -NoNewline -ForegroundColor Red

        $result = Delete-Process -SiteURL $SiteURL -Token $Token -ProcessUniqueId $processUniqueId -ProcessGroupUniqueId $processGroupUniqueId

        if ($result) {
            $results += [PSCustomObject]@{
                ProcessID = $processNumericId
                ProcessUniqueId = $processUniqueId
                Operation = "Delete"
                Status = "Success"
                Message = "Deleted"
            }
        } else {
            $results += [PSCustomObject]@{
                ProcessID = $processNumericId
                ProcessUniqueId = $processUniqueId
                Operation = "Delete"
                Status = "Failed"
                Message = "Delete failed"
            }
        }
    }
    Write-Host ""  # New line after progress counter

    Write-Host "`nProcesses deleted. Total: $($results.Count)" -ForegroundColor Cyan

    # Step 8: Re-archive temporarily restored dependencies
    Write-Host "`n=== PHASE 8: Re-archiving Temporarily Restored Dependencies ===" -ForegroundColor Cyan

    if ($restoredDependencies.Count -gt 0) {
        $currentIndex = 0
        $totalDependencies = $restoredDependencies.Count

        foreach ($restoredDep in $restoredDependencies) {
            $currentIndex++
            Write-Host "`r  Re-archiving $currentIndex out of $totalDependencies..." -NoNewline -ForegroundColor Gray

            $result = Archive-Process -SiteURL $SiteURL -Token $Token -ProcessUniqueId $restoredDep.UniqueId -Comment "Re-archiving after dependency cleanup"
        }
        Write-Host ""  # New line after progress counter

        Write-Host "`nRe-archived $($restoredDependencies.Count) dependencies" -ForegroundColor Green
    } else {
        Write-Host "No dependencies to re-archive" -ForegroundColor Gray
    }
    }  # End of if ($processesToDelete.Count -gt 0)

    # Step 8.5: Delete documents (if requested)
    if ($deleteDocuments -and $documentsToDelete.Count -gt 0) {
        Write-Host "`n=== PHASE 8.5: Deleting Documents ===" -ForegroundColor Cyan
        Write-Host "Found $($documentsToDelete.Count) documents to process" -ForegroundColor Gray

        $documentsToArchive = @()
        $documentsSkipped = @()

        # Check each document for attached processes
        $currentIndex = 0
        $totalDocuments = $documentsToDelete.Count

        foreach ($doc in $documentsToDelete) {
            # Validate document has required properties
            if (-not $doc.documentId -or $doc.documentId -eq 0) {
                $documentsSkipped += [PSCustomObject]@{
                    DocumentId = 0
                    DocumentName = "Unknown"
                    DocumentUniqueId = "Unknown"
                    Reason = "Invalid or missing documentId"
                }
                continue
            }

            $currentIndex++
            Write-Host "`r  Checking documents $currentIndex out of $totalDocuments..." -NoNewline -ForegroundColor Gray

            $hasAttachedProcesses = Test-DocumentHasAttachedProcesses -SiteURL $SiteURL -Token $Token -DocumentId $doc.documentId

            if ($hasAttachedProcesses) {
                $documentsSkipped += [PSCustomObject]@{
                    DocumentId = $doc.documentId
                    DocumentName = $doc.documentName
                    DocumentUniqueId = $doc.documentUniqueId
                    Reason = "Has attached processes"
                }
            } else {
                $documentsToArchive += $doc
            }
        }
        Write-Host ""  # New line after progress counter

        Write-Host "`nDocuments eligible for deletion: $($documentsToArchive.Count)" -ForegroundColor Green
        Write-Host "Documents skipped: $($documentsSkipped.Count)" -ForegroundColor Yellow

        if ($documentsToArchive.Count -gt 0) {
            # Archive documents first
            Write-Host "`n  Archiving documents..." -ForegroundColor Gray
            $archivedCount = 0
            $archiveFailedCount = 0
            $currentIndex = 0
            $totalDocuments = $documentsToArchive.Count

            foreach ($doc in $documentsToArchive) {
                $currentIndex++
                Write-Host "`r    Archiving $currentIndex out of $totalDocuments..." -NoNewline -ForegroundColor Gray

                $archiveResult = Invoke-ArchiveDocument -SiteURL $SiteURL -Token $Token -DocumentId $doc.documentId

                if ($archiveResult) {
                    $archivedCount++
                } else {
                    $archiveFailedCount++
                }
            }
            Write-Host ""  # New line after progress counter

            Write-Host "  Archived: $archivedCount, Failed: $archiveFailedCount" -ForegroundColor Gray

            # Delete archived documents (bulk operation)
            if ($archivedCount -gt 0) {
                Write-Host "`n  Deleting archived documents..." -ForegroundColor Gray
                $documentIds = $documentsToArchive | ForEach-Object { $_.documentId }

                $deleteResult = Invoke-DeleteDocuments -SiteURL $SiteURL -Token $Token -DocumentIds $documentIds

                if ($deleteResult) {
                    Write-Host "  Successfully deleted $($documentIds.Count) documents" -ForegroundColor Green

                    # Add to results
                    foreach ($doc in $documentsToArchive) {
                        $results += [PSCustomObject]@{
                            Type = "Document"
                            Name = $doc.documentName
                            ID = $doc.documentUniqueId
                            Status = "Success"
                            Message = "Deleted"
                        }
                    }
                } else {
                    Write-Host "  Failed to delete documents" -ForegroundColor Red

                    # Mark as failed in results
                    foreach ($doc in $documentsToArchive) {
                        $results += [PSCustomObject]@{
                            Type = "Document"
                            Name = $doc.documentName
                            ID = $doc.documentUniqueId
                            Status = "Failed"
                            Message = "Delete operation failed"
                        }
                    }
                }
            }
        }

        # Add skipped documents to results
        foreach ($skipped in $documentsSkipped) {
            $results += [PSCustomObject]@{
                Type = "Document"
                Name = $skipped.DocumentName
                ID = $skipped.DocumentUniqueId
                Status = "Skipped"
                Message = $skipped.Reason
            }
        }

        Write-Host "`nDocument deletion phase complete" -ForegroundColor Green
        Write-Host "  Deleted: $($documentsToArchive.Count)" -ForegroundColor Cyan
        Write-Host "  Skipped: $($documentsSkipped.Count)" -ForegroundColor Yellow
    }

    # Step 9: Clean up temp group (if it was created)
    if ($tempGroupCreated -and $processesToDelete.Count -gt 0) {
        Write-Host "`n=== PHASE 9: Cleanup ===" -ForegroundColor Cyan
        Write-Host "Deleting temporary group (ID: $tempGroupId, UniqueId: $tempGroupUniqueId)..." -ForegroundColor White

        $deleteSuccess = Delete-ProcessGroup -SiteURL $SiteURL -Token $Token -GroupUniqueId $tempGroupUniqueId

        if (-not $deleteSuccess) {
            Write-Host "  Warning: Failed to delete temporary group. You may need to delete it manually." -ForegroundColor Yellow
        }
    }

    # Optional: Delete the source group folders (only for Group source type)
    if ($SourceType -eq "Group" -and $GroupUniqueId) {
        Write-Host "`n=== OPTIONAL: Process Group Cleanup ===" -ForegroundColor Cyan
        Write-Host "All processes and documents have been deleted from the selected group." -ForegroundColor White
        Write-Host ""
        $deleteGroups = Read-Host "Do you also want to delete the process group folders themselves? (Y/N)"

        if ($deleteGroups -eq 'Y' -or $deleteGroups -eq 'y') {
            Write-Host "`nRetrieving group hierarchy..." -ForegroundColor Cyan
            Write-Host "  Source GroupUniqueId parameter: $GroupUniqueId" -ForegroundColor Gray

            # Get all groups in the tree (sorted by depth, deepest first)
            $groupsToDelete = Get-GroupsInTree -SiteURL $SiteURL -Token $Token -RootGroupUniqueId $GroupUniqueId -IncludeRoot $true

            if ($groupsToDelete.Count -gt 0) {
                Write-Host "Found $($groupsToDelete.Count) group(s) to delete:" -ForegroundColor Yellow
                foreach ($grp in $groupsToDelete) {
                    $indent = "  " * $grp.Depth
                    Write-Host "$indent- $($grp.Name) (Depth: $($grp.Depth))" -ForegroundColor Gray
                }

                Write-Host "`nDeleting groups from bottom to top (children before parents)..." -ForegroundColor Cyan
                $groupDeleteCount = 0
                $groupDeleteFailCount = 0
                $currentIndex = 0
                $totalGroups = $groupsToDelete.Count

                foreach ($grp in $groupsToDelete) {
                    $currentIndex++
                    Write-Host "`r  Deleting group $currentIndex of $totalGroups..." -NoNewline -ForegroundColor Gray

                    $deleteSuccess = Delete-ProcessGroup -SiteURL $SiteURL -Token $Token -GroupUniqueId $grp.UniqueId -Silent

                    if ($deleteSuccess) {
                        $groupDeleteCount++
                        $results += [PSCustomObject]@{
                            ObjectType = "ProcessGroup"
                            ObjectID = $grp.UniqueId
                            Name = $grp.Name
                            Operation = "Delete"
                            Status = "Success"
                            Message = "Group deleted (Depth: $($grp.Depth))"
                        }
                    } else {
                        $groupDeleteFailCount++
                        $results += [PSCustomObject]@{
                            ObjectType = "ProcessGroup"
                            ObjectID = $grp.UniqueId
                            Name = $grp.Name
                            Operation = "Delete"
                            Status = "Failed"
                            Message = "Failed to delete group (Depth: $($grp.Depth))"
                        }
                    }
                }
                Write-Host ""  # New line after progress counter

                Write-Host "`nGroup deletion complete:" -ForegroundColor Green
                Write-Host "  Successfully deleted: $groupDeleteCount" -ForegroundColor Green
                Write-Host "  Failed: $groupDeleteFailCount" -ForegroundColor Red

                if ($groupDeleteFailCount -gt 0) {
                    Write-Host "`nNote: Some groups may have failed to delete if they still contain content" -ForegroundColor Yellow
                    Write-Host "or if there were permissions issues. Check the results CSV for details." -ForegroundColor Yellow
                }
            } else {
                Write-Host "No groups found to delete." -ForegroundColor Yellow
            }
        } else {
            Write-Host "Skipping group folder deletion." -ForegroundColor Yellow
        }
    }

    # Save results
    $timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
    $outputPath = "Delete_Results_$timestamp.csv"
    $results | Export-Csv -Path $outputPath -NoTypeInformation

    Write-Host "`nResults saved to: $outputPath" -ForegroundColor Green
    Write-Host "Total deletions: $($results.Count)" -ForegroundColor Cyan
    Write-Host "Successful: $(($results | Where-Object {$_.Status -eq 'Success'}).Count)" -ForegroundColor Green
    Write-Host "Skipped: $(($results | Where-Object {$_.Status -eq 'Skipped'}).Count)" -ForegroundColor Yellow
    Write-Host "Failed: $(($results | Where-Object {$_.Status -eq 'Failed'}).Count)" -ForegroundColor Red
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
# MAIN SCRIPT
# ============================================================================

# Clear screen
Clear-Host

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  NINTEX PROCESS MANAGER BULK OPERATIONS" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Version 4.0 (Archived Document Deletion)" -ForegroundColor Yellow
Write-Host "  Script loaded: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Yellow
Write-Host ""

# Load configuration
$config = Read-ConfigFile
if (-not $config) {
    Write-Host "Cannot proceed without valid configuration" -ForegroundColor Red
    exit
}

# Authenticate
$token = Get-AuthToken -SiteURL $config.SiteURL -Username $config.Username -Password $config.Password
if (-not $token) {
    Write-Host "Authentication failed. Cannot proceed." -ForegroundColor Red
    exit
}

# Main loop
$running = $true
while ($running) {
    Show-MainMenu
    $mode = Read-Host "Select Mode"

    switch ($mode) {
        '1' {  # Bulk Archive
            $sourceType = Get-SourceType -Mode 1
            $objectType = Get-ObjectType -Mode 1
            $isDryRun = Get-DryRunChoice

            if ($sourceType -eq "CSV") {
                $csvPath = Read-Host "Enter CSV file path"
                if ($isDryRun) {
                    Invoke-BulkArchive -SiteURL $config.SiteURL -Token $token -SourceType $sourceType -ObjectType $objectType -CsvPath $csvPath -WhatIf
                } else {
                    Invoke-BulkArchive -SiteURL $config.SiteURL -Token $token -SourceType $sourceType -ObjectType $objectType -CsvPath $csvPath
                }
            } else {
                $group = Select-ProcessGroup -SiteURL $config.SiteURL -Token $token -Prompt "Select Group to Archive"
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
            $sourceType = Get-SourceType -Mode 2
            $objectType = Get-ObjectType -Mode 2
            $isDryRun = Get-DryRunChoice

            # Get restore target group
            $restoreGroupId = -1
            if ($config.DefaultRestoreGroupID -and $config.DefaultRestoreGroupID -match '^\d+$') {
                $useDefault = Read-Host "Use default restore group ID $($config.DefaultRestoreGroupID)? (Y/N)"
                if ($useDefault -eq 'Y') {
                    $restoreGroupId = [int]$config.DefaultRestoreGroupID
                }
            }

            if ($restoreGroupId -lt 0) {
                $restoreGroup = Select-ProcessGroup -SiteURL $config.SiteURL -Token $token -Prompt "Select Target Group for Restore"
                if ($restoreGroup) {
                    $restoreGroupId = $restoreGroup.id
                }
            }

            if ($restoreGroupId -gt 0) {
                if ($sourceType -eq "CSV") {
                    $csvPath = Read-Host "Enter CSV file path"
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
            $objectType = Get-ObjectType -Mode 3
            $csvPath = Read-Host "Enter CSV file path (must contain ID and NewGroupID columns)"
            $isDryRun = Get-DryRunChoice
            if ($isDryRun) {
                Invoke-BulkUpdateLocation -SiteURL $config.SiteURL -Token $token -ObjectType $objectType -CsvPath $csvPath -WhatIf
            } else {
                Invoke-BulkUpdateLocation -SiteURL $config.SiteURL -Token $token -ObjectType $objectType -CsvPath $csvPath
            }
        }

        '4' {  # Bulk Update Ownership
            $csvPath = Read-Host "Enter CSV file path (must contain ProcessID, NewOwner, NewExpert columns)"
            $isDryRun = Get-DryRunChoice
            if ($isDryRun) {
                Invoke-BulkUpdateOwnership -SiteURL $config.SiteURL -Token $token -CsvPath $csvPath -WhatIf
            } else {
                Invoke-BulkUpdateOwnership -SiteURL $config.SiteURL -Token $token -CsvPath $csvPath
            }
        }

        '5' {  # Bulk Delete Content
            $sourceType = Get-SourceType -Mode 5
            $isDryRun = Get-DryRunChoice

            $tempGroupName = $config.TempGroupName
            if (-not $tempGroupName) {
                $tempGroupName = "Bulk Delete Temporary Group"
            }

            if ($sourceType -eq "CSV") {
                $csvPath = Read-Host "Enter CSV file path"
                if ($isDryRun) {
                    Invoke-BulkDeleteProcesses -SiteURL $config.SiteURL -Token $token -SourceType $sourceType -CsvPath $csvPath -TempGroupName $tempGroupName -CurrentUsername $config.Username -WhatIf
                } else {
                    Invoke-BulkDeleteProcesses -SiteURL $config.SiteURL -Token $token -SourceType $sourceType -CsvPath $csvPath -TempGroupName $tempGroupName -CurrentUsername $config.Username
                }
            } elseif ($sourceType -eq "Archived") {
                # Handle bulk delete of all archived processes
                if ($isDryRun) {
                    Invoke-BulkDeleteProcesses -SiteURL $config.SiteURL -Token $token -SourceType $sourceType -TempGroupName $tempGroupName -CurrentUsername $config.Username -WhatIf
                } else {
                    Invoke-BulkDeleteProcesses -SiteURL $config.SiteURL -Token $token -SourceType $sourceType -TempGroupName $tempGroupName -CurrentUsername $config.Username
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

                        $confirm1 = Read-Host "Type 'DELETE ALL DOCUMENTS' to confirm"
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
                $group = Select-ProcessGroup -SiteURL $config.SiteURL -Token $token -Prompt "Select Group to Delete (WARNING: Destructive!)"
                if ($group) {
                    if ($isDryRun) {
                        Invoke-BulkDeleteProcesses -SiteURL $config.SiteURL -Token $token -SourceType $sourceType -GroupID $group.id -GroupUniqueId $group.uniqueId -TempGroupName $tempGroupName -CurrentUsername $config.Username -WhatIf
                    } else {
                        Invoke-BulkDeleteProcesses -SiteURL $config.SiteURL -Token $token -SourceType $sourceType -GroupID $group.id -GroupUniqueId $group.uniqueId -TempGroupName $tempGroupName -CurrentUsername $config.Username
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

    if ($running) {
        Write-Host "`nPress any key to continue..." -ForegroundColor Gray
        $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    }
}

Write-Host "Thank you for using Nintex Process Manager Bulk Operations!" -ForegroundColor Green
