import { NextResponse } from "next/server";
import { deleteApiKey, getApiKeyById, updateApiKey } from "@/lib/localDb";
import { validateKeyAccessInput } from "@/shared/utils/keyAccess.js";

// GET /api/keys/[id] - Get single key
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    return NextResponse.json({ key });
  } catch (error) {
    console.log("Error fetching key:", error);
    return NextResponse.json({ error: "Failed to fetch key" }, { status: 500 });
  }
}

// PUT /api/keys/[id] - Update key
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { isActive, name, budgetType, budgetLimit, budgetWindow, softThresholdPct, hardBlock, access } = body;

    const existing = await getApiKeyById(id);
    if (!existing) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    const updateData = {};
    if (isActive !== undefined) updateData.isActive = isActive;
    if (name !== undefined) updateData.name = name;

    // Per-key budgets (phase 08): fields ride the existing PUT; per-field
    // clamps live in updateApiKey, the cross-field rule is checked here.
    const hasBudgetField = [budgetType, budgetLimit, budgetWindow, softThresholdPct, hardBlock]
      .some((v) => v !== undefined);
    if (hasBudgetField) {
      const nextType = budgetType !== undefined ? budgetType : existing.budgetType;
      const nextLimit = budgetLimit !== undefined ? Number(budgetLimit) : existing.budgetLimit;
      if (nextType && nextType !== "off" && !(Number.isFinite(nextLimit) && nextLimit > 0)) {
        return NextResponse.json({ error: `Budget limit must be > 0 when budget type is "${nextType}"` }, { status: 400 });
      }
      if (budgetType !== undefined) updateData.budgetType = budgetType;
      if (budgetLimit !== undefined) updateData.budgetLimit = budgetLimit;
      if (budgetWindow !== undefined) updateData.budgetWindow = budgetWindow;
      if (softThresholdPct !== undefined) updateData.softThresholdPct = softThresholdPct;
      if (hardBlock !== undefined) updateData.hardBlock = hardBlock;
    }

    // Upstream v0.5.99: per-key access control ({ restricted, allow }).
    if (access !== undefined) {
      const checked = validateKeyAccessInput(access);
      if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
      updateData.access = checked.value;
    }

    const updated = await updateApiKey(id, updateData);

    return NextResponse.json({ key: updated });
  } catch (error) {
    console.log("Error updating key:", error);
    return NextResponse.json({ error: "Failed to update key" }, { status: 500 });
  }
}

// DELETE /api/keys/[id] - Delete API key
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;

    const deleted = await deleteApiKey(id);
    if (!deleted) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    return NextResponse.json({ message: "Key deleted successfully" });
  } catch (error) {
    console.log("Error deleting key:", error);
    return NextResponse.json({ error: "Failed to delete key" }, { status: 500 });
  }
}
