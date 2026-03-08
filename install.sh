#!/bin/bash

# ============================================================
# OpenClaw WebUI 一键安装脚本
# 支持 Ubuntu / Debian 系统
# ============================================================

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 项目信息
PROJECT_NAME="openclaw-webui"
SERVICE_NAME="openclaw-webui"
REQUIRED_NODE_VERSION="16"

# 打印带颜色的消息
print_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
print_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
print_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
print_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# 获取脚本所在目录（支持符号链接）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 如果是通过符号链接调用，获取真实路径
if [ -L "$0" ]; then
    SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
fi

# ============================================================
# 检查系统类型
# ============================================================
check_system() {
    print_info "检测系统类型..."

    if [ -f /etc/os-release ]; then
        . /etc/os-release
        OS=$ID
        VERSION=$VERSION_ID
        print_info "系统: $PRETTY_NAME"
    else
        print_error "无法检测系统类型，仅支持 Ubuntu/Debian"
        exit 1
    fi

    case $OS in
        ubuntu|debian)
            print_success "系统支持: $OS"
            ;;
        *)
            print_error "不支持的系统: $OS，仅支持 Ubuntu/Debian"
            exit 1
            ;;
    esac
}

# ============================================================
# 检查是否为 root 用户
# ============================================================
check_root() {
    if [ "$EUID" -ne 0 ]; then
        print_warning "建议使用 root 用户或 sudo 执行安装"
        print_info "将尝试使用 sudo 执行需要权限的操作..."
        SUDO="sudo"
    else
        SUDO=""
    fi
}

# ============================================================
# 安装依赖包
# ============================================================
install_dependencies() {
    print_info "安装系统依赖..."

    $SUDO apt-get update -qq
    $SUDO apt-get install -y -qq curl ca-certificates gnupg

    print_success "系统依赖安装完成"
}

# ============================================================
# 检查并安装 Node.js
# ============================================================
install_nodejs() {
    print_info "检查 Node.js..."

    if command -v node &> /dev/null; then
        NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
        print_info "当前 Node.js 版本: $(node -v)"

        if [ "$NODE_VERSION" -ge "$REQUIRED_NODE_VERSION" ]; then
            print_success "Node.js 版本满足要求 (>= $REQUIRED_NODE_VERSION)"
            return 0
        else
            print_warning "Node.js 版本过低，需要 >= $REQUIRED_NODE_VERSION"
        fi
    else
        print_info "Node.js 未安装"
    fi

    print_info "安装 Node.js..."

    # 添加 NodeSource 仓库
    curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO bash -
    $SUDO apt-get install -y -qq nodejs

    # 验证安装
    if command -v node &> /dev/null; then
        print_success "Node.js 安装成功: $(node -v)"
        print_success "npm 版本: $(npm -v)"
    else
        print_error "Node.js 安装失败"
        exit 1
    fi
}

# ============================================================
# 安装项目依赖
# ============================================================
install_project() {
    print_info "安装项目依赖..."

    cd "$SCRIPT_DIR"

    # 清理旧的 node_modules（如果存在）
    if [ -d "node_modules" ]; then
        print_info "清理旧的依赖..."
        rm -rf node_modules package-lock.json
    fi

    npm install --production

    print_success "项目依赖安装完成"
}

# ============================================================
# 配置环境变量
# ============================================================
configure_env() {
    print_info "配置环境变量..."

    cd "$SCRIPT_DIR"

    if [ ! -f ".env" ]; then
        if [ -f ".env.example" ]; then
            cp .env.example .env
            print_success "已创建 .env 配置文件"
        else
            # 创建默认 .env
            cat > .env << 'EOF'
# OpenClaw WebUI 环境配置
PORT=3000
GATEWAY_HOST=localhost
GATEWAY_PORT=18789
GATEWAY_TOKEN=
EOF
            print_success "已创建默认 .env 配置文件"
        fi

        print_warning "请根据实际情况编辑 .env 文件"
    else
        print_info ".env 文件已存在，跳过创建"
    fi

    # 预先创建必要的目录（systemd ReadWritePaths 需要目录存在）
    print_info "创建数据目录..."
    mkdir -p "$SCRIPT_DIR/sessions"
    mkdir -p "$SCRIPT_DIR/data/sessions"
    print_success "数据目录创建完成"
}

# ============================================================
# 创建 systemd 服务
# ============================================================
create_service() {
    print_info "创建 systemd 服务..."

    local SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
    local USER_NAME="${SUDO_USER:-$USER}"
    local USER_HOME=$(eval echo "~$USER_NAME")

    # 创建服务文件
    $SUDO tee "$SERVICE_FILE" > /dev/null << EOF
[Unit]
Description=OpenClaw WebUI - LAN Chat Interface
Documentation=https://github.com/openclaw/openclaw-webui
After=network.target

[Service]
Type=simple
User=${USER_NAME}
WorkingDirectory=${SCRIPT_DIR}
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

# 环境变量
EnvironmentFile=${SCRIPT_DIR}/.env

# 安全设置（放宽限制以允许写入项目目录）
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

    # 重新加载 systemd
    $SUDO systemctl daemon-reload

    print_success "systemd 服务创建成功"
}

# ============================================================
# 配置开机启动
# ============================================================
enable_service() {
    print_info "配置开机启动..."

    $SUDO systemctl enable ${SERVICE_NAME} > /dev/null 2>&1

    print_success "已配置开机启动"
}

# ============================================================
# 启动服务
# ============================================================
start_service() {
    print_info "启动服务..."

    # 检查是否已有服务在运行
    if $SUDO systemctl is-active --quiet ${SERVICE_NAME}; then
        print_info "服务已在运行，正在重启..."
        $SUDO systemctl restart ${SERVICE_NAME}
    else
        $SUDO systemctl start ${SERVICE_NAME}
    fi

    sleep 2

    if $SUDO systemctl is-active --quiet ${SERVICE_NAME}; then
        print_success "服务启动成功"
    else
        print_error "服务启动失败"
        print_info "查看日志: journalctl -u ${SERVICE_NAME} -n 50"
        exit 1
    fi
}

# ============================================================
# 检查 Gateway 连接
# ============================================================
check_gateway() {
    print_info "检查 OpenClaw Gateway 连接..."

    # 读取 .env 配置
    if [ -f "$SCRIPT_DIR/.env" ]; then
        source "$SCRIPT_DIR/.env"
    fi

    GATEWAY_HOST=${GATEWAY_HOST:-localhost}
    GATEWAY_PORT=${GATEWAY_PORT:-18789}

    if curl -s --connect-timeout 3 "http://${GATEWAY_HOST}:${GATEWAY_PORT}/api/status" > /dev/null 2>&1; then
        print_success "Gateway 连接正常: http://${GATEWAY_HOST}:${GATEWAY_PORT}"
    else
        print_warning "无法连接 Gateway: http://${GATEWAY_HOST}:${GATEWAY_PORT}"
        print_info "请确保 OpenClaw Gateway 正在运行"
    fi
}

# ============================================================
# 显示安装结果
# ============================================================
show_result() {
    # 读取端口配置
    PORT=$(grep -E "^PORT=" "$SCRIPT_DIR/.env" 2>/dev/null | cut -d'=' -f2 || echo "3000")
    PORT=${PORT:-3000}

    # 获取 IP 地址
    LOCAL_IP=$(hostname -I | awk '{print $1}')

    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}  OpenClaw WebUI 安装完成${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    echo -e "  本地访问: ${BLUE}http://localhost:${PORT}${NC}"
    if [ -n "$LOCAL_IP" ]; then
        echo -e "  局域网访问: ${BLUE}http://${LOCAL_IP}:${PORT}${NC}"
    fi
    echo ""
    echo -e "  服务状态: ${BLUE}systemctl status ${SERVICE_NAME}${NC}"
    echo -e "  查看日志: ${BLUE}journalctl -u ${SERVICE_NAME} -f${NC}"
    echo -e "  重启服务: ${BLUE}systemctl restart ${SERVICE_NAME}${NC}"
    echo -e "  停止服务: ${BLUE}systemctl stop ${SERVICE_NAME}${NC}"
    echo ""
    echo -e "${YELLOW}提示: 请确保 OpenClaw Gateway 正在运行${NC}"
    echo ""
}

# ============================================================
# 卸载函数
# ============================================================
uninstall() {
    print_info "卸载 OpenClaw WebUI..."

    # 停止并禁用服务
    if $SUDO systemctl is-active --quiet ${SERVICE_NAME}; then
        $SUDO systemctl stop ${SERVICE_NAME}
    fi

    $SUDO systemctl disable ${SERVICE_NAME} > /dev/null 2>&1 || true

    # 删除服务文件
    $SUDO rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
    $SUDO systemctl daemon-reload

    print_success "服务已卸载"
    print_info "项目文件保留在: $SCRIPT_DIR"
    print_info "如需完全删除，请执行: rm -rf $SCRIPT_DIR"
}

# ============================================================
# 主函数
# ============================================================
main() {
    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}  OpenClaw WebUI 安装脚本${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""

    # 检查是否为卸载模式
    if [ "$1" = "--uninstall" ] || [ "$1" = "-u" ]; then
        check_root
        uninstall
        exit 0
    fi

    # 显示帮助
    if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
        echo "用法: $0 [选项]"
        echo ""
        echo "选项:"
        echo "  -h, --help      显示帮助信息"
        echo "  -u, --uninstall 卸载服务"
        echo ""
        echo "无参数运行将执行安装流程"
        exit 0
    fi

    # 执行安装流程
    check_system
    check_root
    install_dependencies
    install_nodejs
    install_project
    configure_env
    create_service
    enable_service
    start_service
    check_gateway
    show_result
}

# 执行主函数
main "$@"