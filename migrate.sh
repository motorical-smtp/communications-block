#!/bin/bash
# Customer-Scoped Suppression Migration Script
# This script safely migrates from tenant-scoped to customer-scoped suppressions

set -e  # Exit on any error

echo "🚀 Customer-Scoped Suppression Migration"
echo "========================================"

# Configuration
BACKUP_DIR="/tmp/comm_migration_$(date +%Y%m%d_%H%M%S)"
DB_NAME="communications_db"
MIGRATION_FILE="migrations/0002_customer_scoped_suppressions.sql"
ROLLBACK_FILE="migrations/rollback_0002.sql"

echo "📋 Migration Plan:"
echo "  • Backup database"
echo "  • Stop services"
echo "  • Run schema migration"
echo "  • Update application code"
echo "  • Test migration"
echo "  • Restart services"
echo "  • Validate production"
echo ""

# Create backup directory
mkdir -p "$BACKUP_DIR"
echo "📁 Backup directory: $BACKUP_DIR"

# Step 1: Create comprehensive backup
echo "💾 Step 1: Creating database backup..."
sudo -u postgres pg_dump "$DB_NAME" > "$BACKUP_DIR/pre_migration_backup.sql"
echo "   ✅ Database backup completed"

# Backup current application code
echo "📄 Backing up application code..."
cp -r src/ "$BACKUP_DIR/src_backup/"
echo "   ✅ Application code backup completed"

# Step 2: Stop services
echo "🛑 Step 2: Stopping services..."
sudo systemctl stop motorical-comm-sender || echo "   ⚠️  Sender service not running"
sudo systemctl stop motorical-comm-stats || echo "   ⚠️  Stats service not running"
echo "   ✅ Services stopped"

# Step 3: Run migration
echo "🔧 Step 3: Running database migration..."
if sudo -u postgres psql -d "$DB_NAME" -f "$MIGRATION_FILE"; then
    echo "   ✅ Database migration completed successfully"
else
    echo "   ❌ Database migration failed!"
    echo "   🔄 Rolling back..."
    sudo -u postgres psql -d "$DB_NAME" -f "$ROLLBACK_FILE"
    echo "   🔄 Restarting services..."
    sudo systemctl start motorical-comm-sender
    sudo systemctl start motorical-comm-stats
    echo "   ❌ Migration aborted due to database error"
    exit 1
fi

# Step 4: Test migration
echo "🧪 Step 4: Testing migration..."
if node test_migration.js; then
    echo "   ✅ Migration tests passed"
else
    echo "   ❌ Migration tests failed!"
    echo "   🔄 Rolling back..."
    sudo -u postgres psql -d "$DB_NAME" -f "$ROLLBACK_FILE"
    echo "   🔄 Restarting services..."
    sudo systemctl start motorical-comm-sender
    sudo systemctl start motorical-comm-stats  
    echo "   ❌ Migration rolled back due to test failures"
    exit 1
fi

# Step 5: Restart services
echo "🔄 Step 5: Restarting services..."
sudo systemctl restart motorical-comm-api
sleep 2
sudo systemctl start motorical-comm-sender
sudo systemctl start motorical-comm-stats
echo "   ✅ Services restarted"

# Step 6: Validate services
echo "✅ Step 6: Validating services..."
sleep 5

# Check service status
for service in motorical-comm-api motorical-comm-sender motorical-comm-stats; do
    if sudo systemctl is-active --quiet "$service"; then
        echo "   ✅ $service is running"
    else
        echo "   ❌ $service is not running!"
        sudo systemctl status "$service" | head -10
    fi
done

# Test API health
if curl -fsS http://127.0.0.1:3011/api/health | jq . > /dev/null 2>&1; then
    echo "   ✅ API health check passed"
else
    echo "   ❌ API health check failed!"
fi

# Step 7: Final validation
echo "🔍 Step 7: Final validation..."
echo "Running final migration test..."
if node test_migration.js; then
    echo "   ✅ Final validation passed"
else
    echo "   ❌ Final validation failed"
    exit 1
fi

# Success!
echo ""
echo "🎉 Migration completed successfully!"
echo "📊 Summary:"
echo "   • Database: ✅ Migrated to customer-scoped suppressions"
echo "   • Services: ✅ Running with updated code"
echo "   • Tests: ✅ All validations passed"
echo "   • Backup: 📁 $BACKUP_DIR"
echo ""
echo "🔍 Monitor logs:"
echo "   sudo journalctl -u motorical-comm-* -f"
echo ""
echo "📝 Rollback (if needed):"
echo "   sudo -u postgres psql -d $DB_NAME -f $ROLLBACK_FILE"
echo "   # Then restore application code from backup"
echo ""
