packer {
  required_plugins {
    azure = {
      source  = "github.com/hashicorp/azure"
      version = "~> 2"
    }
  }
}

variable "subscription_id" {
  type        = string
  description = "Azure subscription ID"
}

variable "client_id" {
  type        = string
  description = "Azure service principal client ID"
}

variable "client_secret" {
  type        = string
  sensitive   = true
  description = "Azure service principal client secret"
}

variable "tenant_id" {
  type        = string
  description = "Azure tenant ID"
}

variable "gallery_name" {
  type        = string
  description = "Azure Shared Image Gallery name"
}

variable "gallery_resource_group" {
  type        = string
  description = "Resource group containing the Shared Image Gallery"
}

variable "gallery_image_name" {
  type        = string
  description = "Image definition name in the gallery"
}

variable "image_version" {
  type        = string
  description = "Image version (e.g. 1.0.0)"
}

variable "location" {
  type        = string
  default     = "westeurope"
  description = "Azure region for the build VM"
}

source "azure-arm" "media-host" {
  subscription_id = var.subscription_id
  client_id       = var.client_id
  client_secret   = var.client_secret
  tenant_id       = var.tenant_id

  os_type         = "Windows"
  image_publisher = "MicrosoftWindowsServer"
  image_offer     = "WindowsServer"
  image_sku       = "2022-datacenter-g2"

  location = var.location
  vm_size  = "Standard_D2s_v3"

  communicator   = "winrm"
  winrm_use_ssl  = true
  winrm_insecure = true
  winrm_timeout  = "10m"
  winrm_username = "packer"

  shared_image_gallery_destination {
    subscription         = var.subscription_id
    resource_group       = var.gallery_resource_group
    gallery_name         = var.gallery_name
    image_name           = var.gallery_image_name
    image_version        = var.image_version
    replication_regions  = [var.location]
    storage_account_type = "Standard_LRS"
  }
}

build {
  sources = ["source.azure-arm.media-host"]

  # Install prerequisites (runtimes, win-acme, IIS, directories)
  provisioner "powershell" {
    script = "${path.root}/scripts/install-prerequisites.ps1"
  }

  # Copy application binaries
  # The ../binaries/ folder must contain TeamsMediaBot/ (self-contained .NET publish output)
  provisioner "file" {
    source      = "../binaries/"
    destination = "C:\\linto-studio-plugins\\"
  }

  # Copy runtime scripts
  provisioner "file" {
    source      = "../scripts/"
    destination = "C:\\linto-studio-plugins\\scripts\\"
  }

  # Sysprep the image for generalization
  provisioner "powershell" {
    inline = [
      "Write-Host 'Running Sysprep...'",
      "& $env:SystemRoot\\System32\\Sysprep\\Sysprep.exe /oobe /generalize /quiet /quit /mode:vm",
      "while ($true) {",
      "  $imageState = (Get-ItemProperty HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Setup\\State).ImageState",
      "  Write-Host \"Image state: $imageState\"",
      "  if ($imageState -eq 'IMAGE_STATE_GENERALIZE_RESEAL_TO_OOBE') { break }",
      "  Start-Sleep -Seconds 10",
      "}"
    ]
  }
}
