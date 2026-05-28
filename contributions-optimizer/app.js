const TAX_DATA_URL = "data/processed/tax_brackets_2026.csv";

const SUPPORTED_FILING_STATUSES = {
  single: "Single",
  married_filing_jointly: "Married filing jointly",
};

const ROTH_IRA_PHASEOUT_2026 = {
  single: [153000, 168000],
  married_filing_jointly: [242000, 252000],
};

const TRADITIONAL_IRA_DEDUCTION_PHASEOUT_2026 = {
  single_active: [81000, 91000],
  married_filing_jointly_active: [129000, 149000],
  married_filing_jointly_spouse_active: [242000, 252000],
};

const SOCIAL_SECURITY_WAGE_BASE_2026 = 184500;
const EMPLOYEE_SOCIAL_SECURITY_RATE = 0.062;
const EMPLOYEE_MEDICARE_RATE = 0.0145;
const ADDITIONAL_MEDICARE_RATE = 0.009;
const ADDITIONAL_MEDICARE_THRESHOLDS = {
  single: 200000,
  married_filing_jointly: 250000,
};
const NIIT_RATE = 0.038;
const NIIT_THRESHOLDS = {
  single: 200000,
  married_filing_jointly: 250000,
};

let taxRows = [];

const moneyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const CHART_COLORS = [
  "#7c3f58",
  "#0f766e",
  "#2f5f9f",
  "#8a5a00",
  "#6f5bb5",
  "#4f6f52",
];

function parseNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCsv(text) {
  const rows = [];
  let field = "";
  let row = [];
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  const headers = rows.shift();
  return rows.filter((item) => item.length === headers.length).map((item) => {
    const record = {};
    headers.forEach((header, index) => {
      record[header] = item[index];
    });
    return record;
  });
}

function normalizeTaxRows(rows) {
  const numericColumns = [
    "tax_year",
    "bracket_order",
    "bracket_lower",
    "bracket_upper",
    "rate",
    "standard_deduction_amount",
    "personal_exemption_amount",
    "dependent_exemption_amount",
  ];

  return rows.map((row) => {
    const normalized = { ...row };
    numericColumns.forEach((column) => {
      normalized[column] = parseNumber(row[column]);
    });
    return normalized;
  });
}

function availableStates(rows) {
  return [...new Set(rows
    .filter((row) => row.tax_type === "state_ordinary_income")
    .map((row) => row.jurisdiction))]
    .sort((a, b) => a.localeCompare(b));
}

function amountIfNotCredit(row, rawColumn, amountColumn) {
  const raw = String(row[rawColumn] || "").toLowerCase();
  if (raw.includes("credit") || ["", "nan", "n.a.", "n.a"].includes(raw)) return 0;
  return row[amountColumn] || 0;
}

function firstMetadataRow(brackets) {
  if (!brackets.length) {
    throw new Error("No bracket rows were found for this jurisdiction and filing status.");
  }
  return [...brackets].sort((a, b) => a.bracket_order - b.bracket_order)[0];
}

function calculateBracketTax(taxableIncome, brackets) {
  const income = Math.max(0, Number(taxableIncome) || 0);
  const ordered = [...brackets].sort((a, b) => a.bracket_lower - b.bracket_lower);
  let tax = 0;
  let marginalRate = 0;

  for (const row of ordered) {
    const lower = row.bracket_lower || 0;
    const upper = row.bracket_upper;
    const rate = row.rate || 0;

    if (income <= lower) break;

    const bracketTop = upper === null ? income : Math.min(income, upper);
    const taxedAmount = Math.max(0, bracketTop - lower);
    tax += taxedAmount * rate;

    if (income > lower) marginalRate = rate;
    if (upper !== null && income <= upper) break;
  }

  return { tax, marginalRate };
}

function calculateStackedCapitalGainsTax(ordinaryTaxableIncome, capitalGainsTaxableIncome, brackets) {
  const ordinary = Math.max(0, ordinaryTaxableIncome || 0);
  const gains = Math.max(0, capitalGainsTaxableIncome || 0);
  if (gains === 0) return { tax: 0, marginalRate: 0 };

  const totalTaxableIncome = ordinary + gains;
  let tax = 0;
  let marginalRate = 0;

  for (const row of [...brackets].sort((a, b) => a.bracket_lower - b.bracket_lower)) {
    const lower = row.bracket_lower || 0;
    const upper = row.bracket_upper;
    const rate = row.rate || 0;
    const bracketTop = upper === null ? totalTaxableIncome : Math.min(totalTaxableIncome, upper);
    const taxableStart = Math.max(lower, ordinary);
    const taxableEnd = Math.min(bracketTop, totalTaxableIncome);
    const taxedAmount = Math.max(0, taxableEnd - taxableStart);
    tax += taxedAmount * rate;
    if (taxedAmount > 0) marginalRate = rate;
    if (upper !== null && totalTaxableIncome <= upper) break;
  }

  return { tax, marginalRate };
}

function calculateJurisdictionTax({ jurisdictionCode, taxType, filingStatus, grossIncome, dependents = 0 }) {
  const brackets = taxRows.filter((row) => (
    row.jurisdiction_code === jurisdictionCode
    && row.tax_type === taxType
    && row.filing_status === filingStatus
  ));
  const meta = firstMetadataRow(brackets);
  const standardDeduction = amountIfNotCredit(meta, "standard_deduction_raw", "standard_deduction_amount");
  const personalExemption = amountIfNotCredit(meta, "personal_exemption_raw", "personal_exemption_amount");
  const dependentExemption = amountIfNotCredit(meta, "dependent_exemption_raw", "dependent_exemption_amount");
  const taxableIncome = Math.max(
    0,
    grossIncome - standardDeduction - personalExemption - dependentExemption * Math.max(0, dependents),
  );
  const { tax, marginalRate } = calculateBracketTax(taxableIncome, brackets);

  return {
    jurisdiction: meta.jurisdiction,
    taxableIncome,
    tax,
    effectiveRate: grossIncome > 0 ? tax / grossIncome : 0,
    marginalRate,
    standardDeduction,
    personalExemption,
    dependentExemption,
    ordinaryTaxableIncome: taxableIncome,
    longTermCapitalGainsTaxableIncome: 0,
    longTermCapitalGainsTax: 0,
    longTermCapitalGainsMarginalRate: 0,
  };
}

function calculateFederalIncomeTax({ filingStatus, grossIncome, longTermCapitalGainsIncome = 0, dependents = 0 }) {
  const ordinaryIncome = Math.max(0, grossIncome - longTermCapitalGainsIncome);
  const ordinaryBrackets = taxRows.filter((row) => (
    row.jurisdiction_code === "US"
    && row.tax_type === "federal_ordinary_income"
    && row.filing_status === filingStatus
  ));
  const capitalGainsBrackets = taxRows.filter((row) => (
    row.jurisdiction_code === "US"
    && row.tax_type === "federal_long_term_capital_gains"
    && row.filing_status === filingStatus
  ));
  const meta = firstMetadataRow(ordinaryBrackets);
  const standardDeduction = amountIfNotCredit(meta, "standard_deduction_raw", "standard_deduction_amount");
  const personalExemption = amountIfNotCredit(meta, "personal_exemption_raw", "personal_exemption_amount");
  const dependentExemption = amountIfNotCredit(meta, "dependent_exemption_raw", "dependent_exemption_amount");
  const totalDeductions = standardDeduction + personalExemption + dependentExemption * Math.max(0, dependents);
  const ordinaryTaxableIncome = Math.max(0, ordinaryIncome - totalDeductions);
  const unusedDeductions = Math.max(0, totalDeductions - ordinaryIncome);
  const longTermCapitalGainsTaxableIncome = Math.max(0, longTermCapitalGainsIncome - unusedDeductions);
  const ordinaryResult = calculateBracketTax(ordinaryTaxableIncome, ordinaryBrackets);
  const gainsResult = calculateStackedCapitalGainsTax(
    ordinaryTaxableIncome,
    longTermCapitalGainsTaxableIncome,
    capitalGainsBrackets,
  );
  const tax = ordinaryResult.tax + gainsResult.tax;
  const taxableIncome = ordinaryTaxableIncome + longTermCapitalGainsTaxableIncome;

  return {
    jurisdiction: "United States",
    taxableIncome,
    tax,
    effectiveRate: grossIncome > 0 ? tax / grossIncome : 0,
    marginalRate: ordinaryResult.marginalRate,
    standardDeduction,
    personalExemption,
    dependentExemption,
    ordinaryTaxableIncome,
    longTermCapitalGainsTaxableIncome,
    longTermCapitalGainsTax: gainsResult.tax,
    longTermCapitalGainsMarginalRate: gainsResult.marginalRate,
  };
}

function calculateEffectiveIncomeTaxRate({
  grossIncome,
  state,
  filingStatus,
  dependents = 0,
  longTermCapitalGainsPercent = 0,
  longTermCapitalGainsIncome = null,
}) {
  if (!SUPPORTED_FILING_STATUSES[filingStatus]) throw new Error(`Unsupported filing status: ${filingStatus}`);
  if (grossIncome < 0) throw new Error("Gross income cannot be negative.");

  const stateRows = taxRows.filter((row) => row.tax_type === "state_ordinary_income" && row.jurisdiction === state);
  if (!stateRows.length) throw new Error(`State not found in tax data: ${state}`);
  const stateCode = stateRows[0].jurisdiction_code;
  const modeledLongTermCapitalGainsIncome = longTermCapitalGainsIncome === null
    ? grossIncome * Math.min(1, Math.max(0, longTermCapitalGainsPercent))
    : Math.min(grossIncome, Math.max(0, longTermCapitalGainsIncome));
  const ordinaryIncome = grossIncome - modeledLongTermCapitalGainsIncome;
  const federal = calculateFederalIncomeTax({
    filingStatus,
    grossIncome,
    longTermCapitalGainsIncome: modeledLongTermCapitalGainsIncome,
    dependents,
  });
  const stateTax = calculateJurisdictionTax({
    jurisdictionCode: stateCode,
    taxType: "state_ordinary_income",
    filingStatus,
    grossIncome,
    dependents,
  });
  const stateCapitalGainsRows = taxRows.filter((row) => (
    row.jurisdiction_code === stateCode
    && row.tax_type === "state_capital_gains"
    && row.filing_status === filingStatus
  ));
  let stateCapitalGainsTax = null;
  let stateCapitalGainsTaxAmount = 0;

  if (modeledLongTermCapitalGainsIncome > 0 && stateCapitalGainsRows.length) {
    stateCapitalGainsTax = calculateJurisdictionTax({
      jurisdictionCode: stateCode,
      taxType: "state_capital_gains",
      filingStatus,
      grossIncome: modeledLongTermCapitalGainsIncome,
      dependents: 0,
    });
    stateCapitalGainsTaxAmount = stateCapitalGainsTax.tax;
  }

  const niitThreshold = NIIT_THRESHOLDS[filingStatus];
  const niitTaxableAmount = niitThreshold === undefined
    ? 0
    : Math.min(modeledLongTermCapitalGainsIncome, Math.max(0, grossIncome - niitThreshold));
  const niitTax = niitTaxableAmount * NIIT_RATE;
  const totalTax = federal.tax + stateTax.tax + stateCapitalGainsTaxAmount + niitTax;
  return {
    grossIncome,
    ordinaryIncome,
    longTermCapitalGainsIncome: modeledLongTermCapitalGainsIncome,
    longTermCapitalGainsPercent: grossIncome > 0 ? modeledLongTermCapitalGainsIncome / grossIncome : 0,
    filingStatus,
    state,
    dependents,
    federal,
    stateTax,
    stateCapitalGainsTax,
    niitTax,
    niitTaxableAmount,
    totalTax,
    combinedEffectiveRate: grossIncome > 0 ? totalTax / grossIncome : 0,
    combinedMarginalRate: federal.marginalRate + stateTax.marginalRate,
  };
}

function splitIncomeByLtcgShare(income, ltcgShare) {
  const total = Math.max(0, income || 0);
  const share = clampPercent(ltcgShare, 0);
  const longTermCapitalGainsIncome = total * share;
  return {
    ordinaryIncome: total - longTermCapitalGainsIncome,
    longTermCapitalGainsIncome,
  };
}

function totalIncomeTax({ income, state, filingStatus, dependents, longTermCapitalGainsIncome = 0 }) {
  if (income <= 0) return 0;
  return calculateEffectiveIncomeTaxRate({
    grossIncome: income,
    state,
    filingStatus,
    dependents,
    longTermCapitalGainsIncome,
  }).totalTax;
}

function totalIncomeTaxForComponents({
  ordinaryIncome,
  longTermCapitalGainsIncome = 0,
  state,
  filingStatus,
  dependents,
}) {
  const ordinary = Math.max(0, ordinaryIncome || 0);
  const ltcg = Math.max(0, longTermCapitalGainsIncome || 0);
  return totalIncomeTax({
    income: ordinary + ltcg,
    state,
    filingStatus,
    dependents,
    longTermCapitalGainsIncome: ltcg,
  });
}

function taxImpactForKnownIncome({
  baselineOrdinaryIncome,
  baselineLongTermCapitalGainsIncome = 0,
  additionalOrdinaryIncome = 0,
  additionalLongTermCapitalGainsIncome = 0,
  state,
  filingStatus,
  dependents,
}) {
  if (additionalOrdinaryIncome <= 0 && additionalLongTermCapitalGainsIncome <= 0) return 0;
  const baseTax = totalIncomeTaxForComponents({
    ordinaryIncome: baselineOrdinaryIncome,
    longTermCapitalGainsIncome: baselineLongTermCapitalGainsIncome,
    state,
    filingStatus,
    dependents,
  });
  const fullTax = totalIncomeTaxForComponents({
    ordinaryIncome: baselineOrdinaryIncome + additionalOrdinaryIncome,
    longTermCapitalGainsIncome: baselineLongTermCapitalGainsIncome + additionalLongTermCapitalGainsIncome,
    state,
    filingStatus,
    dependents,
  });
  return Math.max(0, fullTax - baseTax);
}

function incrementalOrdinaryTax({
  baselineIncome,
  baselineLongTermCapitalGainsShare = 0,
  additionalOrdinaryIncome,
  state,
  filingStatus,
  dependents,
}) {
  if (additionalOrdinaryIncome <= 0) return 0;
  const baseline = splitIncomeByLtcgShare(baselineIncome, baselineLongTermCapitalGainsShare);
  return taxImpactForKnownIncome({
    baselineOrdinaryIncome: baseline.ordinaryIncome,
    baselineLongTermCapitalGainsIncome: baseline.longTermCapitalGainsIncome,
    additionalOrdinaryIncome,
    state,
    filingStatus,
    dependents,
  });
}

function incrementalOrdinaryTaxFromComponents({
  baselineOrdinaryIncome,
  baselineLongTermCapitalGainsIncome = 0,
  additionalOrdinaryIncome,
  state,
  filingStatus,
  dependents,
}) {
  if (additionalOrdinaryIncome <= 0) return 0;
  return taxImpactForKnownIncome({
    baselineOrdinaryIncome,
    baselineLongTermCapitalGainsIncome,
    additionalOrdinaryIncome,
    state,
    filingStatus,
    dependents,
  });
}

function ordinarySliceLowHighRates({
  baselineIncome,
  baselineLongTermCapitalGainsShare = 0,
  additionalOrdinaryIncome,
  state,
  filingStatus,
  dependents,
}) {
  if (additionalOrdinaryIncome <= 0) return [0, 0];
  const lowIncrement = Math.min(1, additionalOrdinaryIncome);
  const highIncrement = Math.min(1, additionalOrdinaryIncome);
  const lowTax = incrementalOrdinaryTax({
    baselineIncome,
    baselineLongTermCapitalGainsShare,
    additionalOrdinaryIncome: lowIncrement,
    state,
    filingStatus,
    dependents,
  });
  const fullTax = incrementalOrdinaryTax({
    baselineIncome,
    baselineLongTermCapitalGainsShare,
    additionalOrdinaryIncome,
    state,
    filingStatus,
    dependents,
  });
  const beforeHighTax = incrementalOrdinaryTax({
    baselineIncome,
    baselineLongTermCapitalGainsShare,
    additionalOrdinaryIncome: additionalOrdinaryIncome - highIncrement,
    state,
    filingStatus,
    dependents,
  });
  return [Math.max(0, lowTax / lowIncrement), Math.max(0, (fullTax - beforeHighTax) / highIncrement)];
}

function ordinarySliceLowHighRatesFromComponents({
  baselineOrdinaryIncome,
  baselineLongTermCapitalGainsIncome = 0,
  additionalOrdinaryIncome,
  state,
  filingStatus,
  dependents,
}) {
  if (additionalOrdinaryIncome <= 0) return [0, 0];
  const lowIncrement = Math.min(1, additionalOrdinaryIncome);
  const highIncrement = Math.min(1, additionalOrdinaryIncome);
  const lowTax = incrementalOrdinaryTaxFromComponents({
    baselineOrdinaryIncome,
    baselineLongTermCapitalGainsIncome,
    additionalOrdinaryIncome: lowIncrement,
    state,
    filingStatus,
    dependents,
  });
  const fullTax = incrementalOrdinaryTaxFromComponents({
    baselineOrdinaryIncome,
    baselineLongTermCapitalGainsIncome,
    additionalOrdinaryIncome,
    state,
    filingStatus,
    dependents,
  });
  const beforeHighTax = incrementalOrdinaryTaxFromComponents({
    baselineOrdinaryIncome,
    baselineLongTermCapitalGainsIncome,
    additionalOrdinaryIncome: additionalOrdinaryIncome - highIncrement,
    state,
    filingStatus,
    dependents,
  });
  return [Math.max(0, lowTax / lowIncrement), Math.max(0, (fullTax - beforeHighTax) / highIncrement)];
}

function afterTaxIncomeForComponents({
  ordinaryIncome,
  longTermCapitalGainsIncome = 0,
  state,
  filingStatus,
  dependents,
}) {
  const ordinary = Math.max(0, ordinaryIncome || 0);
  const ltcg = Math.max(0, longTermCapitalGainsIncome || 0);
  const tax = totalIncomeTaxForComponents({
    ordinaryIncome: ordinary,
    longTermCapitalGainsIncome: ltcg,
    state,
    filingStatus,
    dependents,
  });
  return Math.max(0, ordinary + ltcg - tax);
}

function afterTaxIncomeWithSplit({
  income,
  ltcgShare = 0,
  state,
  filingStatus,
  dependents,
}) {
  const split = splitIncomeByLtcgShare(income, ltcgShare);
  return afterTaxIncomeForComponents({
    ordinaryIncome: split.ordinaryIncome,
    longTermCapitalGainsIncome: split.longTermCapitalGainsIncome,
    state,
    filingStatus,
    dependents,
  });
}

function solveBaselineForKnownWithdrawal({
  withdrawalCash,
  taxableOrdinaryWithdrawal = 0,
  taxableLongTermCapitalGainsWithdrawal = 0,
  requiredAfterTaxIncome,
  baselineLongTermCapitalGainsShare = 0,
  state,
  filingStatus,
  dependents,
}) {
  if (withdrawalCash <= 0) return [0, 0];

  const taxImpactAtBaseline = (baselineIncome) => {
    const baseline = splitIncomeByLtcgShare(baselineIncome, baselineLongTermCapitalGainsShare);
    return taxImpactForKnownIncome({
      baselineOrdinaryIncome: baseline.ordinaryIncome,
      baselineLongTermCapitalGainsIncome: baseline.longTermCapitalGainsIncome,
      additionalOrdinaryIncome: taxableOrdinaryWithdrawal,
      additionalLongTermCapitalGainsIncome: taxableLongTermCapitalGainsWithdrawal,
      state,
      filingStatus,
      dependents,
    });
  };

  const netIncomeWithWithdrawal = (baselineIncome) => (
    afterTaxIncomeWithSplit({
      income: baselineIncome,
      ltcgShare: baselineLongTermCapitalGainsShare,
      state,
      filingStatus,
      dependents,
    })
    + withdrawalCash
    - taxImpactAtBaseline(baselineIncome)
  );

  let baselineIncome = 0;
  if (netIncomeWithWithdrawal(0) < requiredAfterTaxIncome) {
    let low = 0;
    let high = Math.max(requiredAfterTaxIncome * 2, withdrawalCash * 2, 1);
    while (netIncomeWithWithdrawal(high) < requiredAfterTaxIncome) {
      high *= 2;
    }
    for (let index = 0; index < 60; index += 1) {
      const mid = (low + high) / 2;
      if (netIncomeWithWithdrawal(mid) < requiredAfterTaxIncome) low = mid;
      else high = mid;
    }
    baselineIncome = high;
  }

  return [baselineIncome, taxImpactAtBaseline(baselineIncome)];
}

function solveBaselineForOrdinaryWithdrawal({
  grossWithdrawal,
  requiredAfterTaxIncome,
  baselineLongTermCapitalGainsShare = 0,
  state,
  filingStatus,
  dependents,
}) {
  return solveBaselineForKnownWithdrawal({
    withdrawalCash: grossWithdrawal,
    taxableOrdinaryWithdrawal: grossWithdrawal,
    requiredAfterTaxIncome,
    baselineLongTermCapitalGainsShare,
    state,
    filingStatus,
    dependents,
  });
}

function incrementalLongTermCapitalGainsTax({
  baselineIncome = null,
  baselineLongTermCapitalGainsShare = 0,
  baselineOrdinaryIncome = 0,
  baselineLongTermCapitalGainsIncome = 0,
  additionalLongTermCapitalGains,
  state,
  filingStatus,
  dependents,
}) {
  if (additionalLongTermCapitalGains <= 0) return 0;
  const baseline = baselineIncome === null
    ? { ordinaryIncome: baselineOrdinaryIncome, longTermCapitalGainsIncome: baselineLongTermCapitalGainsIncome }
    : splitIncomeByLtcgShare(baselineIncome, baselineLongTermCapitalGainsShare);
  return taxImpactForKnownIncome({
    baselineOrdinaryIncome: baseline.ordinaryIncome,
    baselineLongTermCapitalGainsIncome: baseline.longTermCapitalGainsIncome,
    additionalLongTermCapitalGainsIncome: additionalLongTermCapitalGains,
    state,
    filingStatus,
    dependents,
  });
}

function longTermCapitalGainsSliceLowHighRates({
  baselineIncome = null,
  baselineLongTermCapitalGainsShare = 0,
  baselineOrdinaryIncome = 0,
  baselineLongTermCapitalGainsIncome = 0,
  additionalLongTermCapitalGains,
  state,
  filingStatus,
  dependents,
}) {
  if (additionalLongTermCapitalGains <= 0) return [0, 0];
  const lowIncrement = Math.min(1, additionalLongTermCapitalGains);
  const highIncrement = Math.min(1, additionalLongTermCapitalGains);
  const baseline = baselineIncome === null
    ? { ordinaryIncome: baselineOrdinaryIncome, longTermCapitalGainsIncome: baselineLongTermCapitalGainsIncome }
    : splitIncomeByLtcgShare(baselineIncome, baselineLongTermCapitalGainsShare);
  const lowTax = incrementalLongTermCapitalGainsTax({
    baselineOrdinaryIncome: baseline.ordinaryIncome,
    baselineLongTermCapitalGainsIncome: baseline.longTermCapitalGainsIncome,
    additionalLongTermCapitalGains: lowIncrement,
    state,
    filingStatus,
    dependents,
  });
  const fullTax = incrementalLongTermCapitalGainsTax({
    baselineOrdinaryIncome: baseline.ordinaryIncome,
    baselineLongTermCapitalGainsIncome: baseline.longTermCapitalGainsIncome,
    additionalLongTermCapitalGains,
    state,
    filingStatus,
    dependents,
  });
  const beforeHighTax = incrementalLongTermCapitalGainsTax({
    baselineOrdinaryIncome: baseline.ordinaryIncome,
    baselineLongTermCapitalGainsIncome: baseline.longTermCapitalGainsIncome,
    additionalLongTermCapitalGains: additionalLongTermCapitalGains - highIncrement,
    state,
    filingStatus,
    dependents,
  });
  return [Math.max(0, lowTax / lowIncrement), Math.max(0, (fullTax - beforeHighTax) / highIncrement)];
}

function solveTaxableBrokerageWithdrawalForNet({
  accountValue,
  basis,
  requiredAfterTaxIncome,
  baselineLongTermCapitalGainsShare = 0,
  state,
  filingStatus,
  dependents,
}) {
  if (accountValue <= 0) return [0, 0, 0, requiredAfterTaxIncome];
  const gainRatio = Math.max(0, accountValue - basis) / accountValue;
  const taxableGain = accountValue * gainRatio;
  const [baselineIncome, tax] = solveBaselineForKnownWithdrawal({
    withdrawalCash: accountValue,
    taxableLongTermCapitalGainsWithdrawal: taxableGain,
    requiredAfterTaxIncome,
    baselineLongTermCapitalGainsShare,
    state,
    filingStatus,
    dependents,
  });
  return [accountValue, tax, taxableGain, baselineIncome];
}

function solvePretaxIncomeForAfterTaxIncome({
  requiredAfterTaxIncome,
  longTermCapitalGainsShare = 0,
  state,
  filingStatus,
  dependents,
}) {
  const target = Math.max(0, requiredAfterTaxIncome || 0);
  if (target <= 0) return 0;

  const afterTaxAt = (income) => afterTaxIncomeWithSplit({
    income,
    ltcgShare: longTermCapitalGainsShare,
    state,
    filingStatus,
    dependents,
  });

  let low = 0;
  let high = Math.max(target * 2, 1);
  while (afterTaxAt(high) < target) {
    high *= 2;
  }
  for (let index = 0; index < 60; index += 1) {
    const mid = (low + high) / 2;
    if (afterTaxAt(mid) < target) low = mid;
    else high = mid;
  }
  return high;
}

function phaseoutFraction(income, lower, upper) {
  if (income <= lower) return 1;
  if (income >= upper) return 0;
  return (upper - income) / (upper - lower);
}

function rothIraEligibilityNote(income, filingStatus) {
  const limits = ROTH_IRA_PHASEOUT_2026[filingStatus];
  if (!limits) return "Roth IRA income phaseout not modeled for this filing status.";
  const [lower, upper] = limits;
  if (income <= lower) return "Direct Roth IRA contribution appears income-eligible.";
  if (income < upper) return "Direct Roth IRA contribution may be partially income-limited.";
  return "Direct Roth IRA contribution appears income-ineligible; consider a backdoor Roth IRA contribution.";
}

function rothIraContributionFraction(income, filingStatus) {
  const limits = ROTH_IRA_PHASEOUT_2026[filingStatus];
  if (!limits) return 1;
  return phaseoutFraction(income, ...limits);
}

function traditionalIraDeductionFraction(income, filingStatus, coveredByWorkplacePlan, spouseCoveredByWorkplacePlan) {
  if (!coveredByWorkplacePlan && !spouseCoveredByWorkplacePlan) return 1;
  if (filingStatus === "single" && coveredByWorkplacePlan) {
    return phaseoutFraction(income, ...TRADITIONAL_IRA_DEDUCTION_PHASEOUT_2026.single_active);
  }
  if (filingStatus === "married_filing_jointly" && coveredByWorkplacePlan) {
    return phaseoutFraction(income, ...TRADITIONAL_IRA_DEDUCTION_PHASEOUT_2026.married_filing_jointly_active);
  }
  if (filingStatus === "married_filing_jointly" && spouseCoveredByWorkplacePlan) {
    return phaseoutFraction(income, ...TRADITIONAL_IRA_DEDUCTION_PHASEOUT_2026.married_filing_jointly_spouse_active);
  }
  return 0;
}

function traditionalIraEligibilityNote(deductionFraction) {
  if (deductionFraction >= 0.999) return "Traditional IRA contribution appears fully deductible under the modeled inputs.";
  if (deductionFraction > 0) return "Traditional IRA deduction appears partially income-limited.";
  return "Traditional IRA deduction appears income-ineligible; modeled as nondeductible basis plus taxable earnings.";
}

function futureValue(amount, years, annualReturn, annualExpense = 0) {
  const netReturn = annualReturn - annualExpense;
  return amount * ((1 + netReturn) ** Math.max(0, years));
}

function clampPercent(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(1, Math.max(0, parsed));
}

function individualSocialSecuritySavings(wageIncomeBeforeContribution, contribution) {
  const wageIncomeAfterContribution = Math.max(0, wageIncomeBeforeContribution - contribution);
  const socialSecurityBefore = Math.min(wageIncomeBeforeContribution, SOCIAL_SECURITY_WAGE_BASE_2026);
  const socialSecurityAfter = Math.min(wageIncomeAfterContribution, SOCIAL_SECURITY_WAGE_BASE_2026);
  return (socialSecurityBefore - socialSecurityAfter) * EMPLOYEE_SOCIAL_SECURITY_RATE;
}

function hsaPayrollTaxSavings({
  wageIncomeBeforeContribution,
  contribution,
  filingStatus,
  primaryEarnerShare = 1,
}) {
  const householdIncome = Math.max(0, wageIncomeBeforeContribution);
  const householdContribution = Math.max(0, contribution);
  const householdShare = filingStatus === "married_filing_jointly"
    ? clampPercent(primaryEarnerShare, 0.5)
    : 1;
  const primaryIncome = householdIncome * householdShare;
  const spouseIncome = householdIncome - primaryIncome;
  const primaryContribution = householdContribution * householdShare;
  const spouseContribution = householdContribution - primaryContribution;
  const socialSecuritySavings = individualSocialSecuritySavings(primaryIncome, primaryContribution)
    + individualSocialSecuritySavings(spouseIncome, spouseContribution);
  const medicareSavings = householdContribution * EMPLOYEE_MEDICARE_RATE;
  const additionalMedicareThreshold = ADDITIONAL_MEDICARE_THRESHOLDS[filingStatus];
  let additionalMedicareSavings = 0;
  if (additionalMedicareThreshold !== undefined) {
    const additionalBefore = Math.max(0, householdIncome - additionalMedicareThreshold);
    const additionalAfter = Math.max(0, householdIncome - householdContribution - additionalMedicareThreshold);
    additionalMedicareSavings = (additionalBefore - additionalAfter) * ADDITIONAL_MEDICARE_RATE;
  }
  return Math.max(0, socialSecuritySavings + medicareSavings + additionalMedicareSavings);
}

function incomeTaxCostOnIncomeSlice({
  currentIncome,
  currentLongTermCapitalGainsShare = 0,
  incomeSlice,
  state,
  filingStatus,
  dependents,
}) {
  if (incomeSlice <= 0) return 0;
  const currentSplit = splitIncomeByLtcgShare(currentIncome, currentLongTermCapitalGainsShare);
  const ordinarySlice = Math.min(incomeSlice, currentSplit.ordinaryIncome);
  const before = totalIncomeTaxForComponents({
    ordinaryIncome: Math.max(0, currentSplit.ordinaryIncome - ordinarySlice),
    longTermCapitalGainsIncome: currentSplit.longTermCapitalGainsIncome,
    state,
    filingStatus,
    dependents,
  });
  const after = totalIncomeTaxForComponents({
    ordinaryIncome: currentSplit.ordinaryIncome,
    longTermCapitalGainsIncome: currentSplit.longTermCapitalGainsIncome,
    state,
    filingStatus,
    dependents,
  });
  return Math.max(0, after - before);
}

function optimizeIncrementalRetirementDollar(inputs) {
  const years = Math.max(0, inputs.withdrawalAge - inputs.currentAge);
  const rothIraFraction = rothIraContributionFraction(inputs.currentIncome, inputs.filingStatus);
  const iraDeductionFraction = traditionalIraDeductionFraction(
    inputs.currentIncome,
    inputs.filingStatus,
    inputs.coveredByWorkplacePlan,
    inputs.spouseCoveredByWorkplacePlan,
  );
  const results = [];
  const currentIncomeSplit = splitIncomeByLtcgShare(inputs.currentIncome, inputs.currentLongTermCapitalGainsShare);
  const ordinaryContributionSlice = Math.min(inputs.pretaxBudget, currentIncomeSplit.ordinaryIncome);
  const contributionBaselineOrdinaryIncome = Math.max(0, currentIncomeSplit.ordinaryIncome - ordinaryContributionSlice);
  const currentIncomeTaxOnBudget = incomeTaxCostOnIncomeSlice({
    currentIncome: inputs.currentIncome,
    currentLongTermCapitalGainsShare: inputs.currentLongTermCapitalGainsShare,
    incomeSlice: inputs.pretaxBudget,
    state: inputs.currentState,
    filingStatus: inputs.filingStatus,
    dependents: inputs.dependents,
  });
  const [contributionIncomeLowRate, contributionIncomeHighRate] = ordinarySliceLowHighRatesFromComponents({
    baselineOrdinaryIncome: contributionBaselineOrdinaryIncome,
    baselineLongTermCapitalGainsIncome: currentIncomeSplit.longTermCapitalGainsIncome,
    additionalOrdinaryIncome: ordinaryContributionSlice,
    state: inputs.currentState,
    filingStatus: inputs.filingStatus,
    dependents: inputs.dependents,
  });
  const payrollTaxOnBudget = hsaPayrollTaxSavings({
    wageIncomeBeforeContribution: currentIncomeSplit.ordinaryIncome,
    contribution: ordinaryContributionSlice,
    filingStatus: inputs.filingStatus,
    primaryEarnerShare: inputs.primaryEarnerShare,
  });
  const afterTaxBudget = Math.max(0, inputs.pretaxBudget - currentIncomeTaxOnBudget - payrollTaxOnBudget);
  const payrollTaxRateOnBudget = inputs.pretaxBudget ? payrollTaxOnBudget / inputs.pretaxBudget : 0;
  const taxableContributionLowRate = contributionIncomeLowRate + payrollTaxRateOnBudget;
  const taxableContributionHighRate = contributionIncomeHighRate + payrollTaxRateOnBudget;
  const rothEarlyWithdrawalFootnote = {
    severity: "warning",
    text: "Planned withdrawal age is before 59 1/2, so qualified Roth withdrawal treatment may not be available.",
  };
  const traditionalIraEarlyWithdrawalFootnote = {
    severity: "warning",
    text: "Planned withdrawal age is before 59 1/2, so Traditional IRA withdrawals may face a 10% early-distribution tax unless an exception applies.",
  };
  const k401EarlyWithdrawalFootnote = {
    severity: "warning",
    text: "Planned withdrawal age is before 59 1/2; 401k withdrawals may face a 10% early-distribution tax unless an exception applies, and access can depend on plan rules.",
  };
  const hsaEarlyWithdrawalFootnote = {
    severity: "warning",
    text: "Planned withdrawal age is before 65; nonmedical HSA withdrawals may face a 20% additional tax, while qualified medical expenses can be tax-free.",
  };
  const wageLimitedFootnote = {
    severity: "warning",
    text: "Modeled wage/ordinary income is below the pretax amount being compared, so payroll-style contribution benefits are limited.",
  };
  const payrollContributionFootnotes = ordinaryContributionSlice < inputs.pretaxBudget ? [wageLimitedFootnote] : [];
  const rothWithdrawalFootnotes = inputs.withdrawalAge < 60 ? [rothEarlyWithdrawalFootnote] : [];
  const traditionalIraWithdrawalFootnotes = inputs.withdrawalAge < 60 ? [traditionalIraEarlyWithdrawalFootnote] : [];
  const k401WithdrawalFootnotes = inputs.withdrawalAge < 60 ? [k401EarlyWithdrawalFootnote] : [];
  const hsaWithdrawalFootnotes = inputs.withdrawalAge < 65 ? [hsaEarlyWithdrawalFootnote] : [];

  const addCommonFields = (row) => {
    const isUnavailable = row.futureValueAfterTax === null;
    const enriched = {
      ...row,
      pretaxIncomeContributionToday: inputs.pretaxBudget,
      postTaxContributionToday: row.contributionToday,
      contributionEffectiveTaxRate: inputs.pretaxBudget
        ? (inputs.pretaxBudget - row.contributionToday) / inputs.pretaxBudget
        : 0,
      withdrawalEffectiveTaxRate: row.futureValueBeforeTax
        ? row.taxDueAtWithdrawal / row.futureValueBeforeTax
        : 0,
      baselinePretaxIncomeBeforeWithdrawal: row.baselinePretaxIncomeBeforeWithdrawal ?? null,
      futureValueNoFeesOrTaxes: futureValue(inputs.pretaxBudget, years, inputs.annualReturn, 0),
      yearsToWithdrawal: years,
      footnotes: row.footnotes || [],
      headerWarning: Boolean(row.headerWarning),
      contributionUnavailable: Boolean(row.contributionUnavailable),
    };
    enriched.totalFeesAndTaxImpact = isUnavailable
      ? null
      : Math.max(0, enriched.futureValueNoFeesOrTaxes - enriched.futureValueAfterTax);
    enriched.totalFeesAndTaxImpactPct = isUnavailable
      ? null
      : (enriched.futureValueNoFeesOrTaxes ? enriched.totalFeesAndTaxImpact / enriched.futureValueNoFeesOrTaxes : 0);
    enriched.netTotalGrowthPct = isUnavailable
      ? null
      : (inputs.pretaxBudget ? (enriched.futureValueAfterTax / inputs.pretaxBudget) - 1 : 0);
    enriched.netAnnualizedGrowthPct = isUnavailable
      ? null
      : (years > 0 && inputs.pretaxBudget > 0
        ? ((enriched.futureValueAfterTax / inputs.pretaxBudget) ** (1 / years)) - 1
        : enriched.netTotalGrowthPct);
    return enriched;
  };

  const rothIraContribution = afterTaxBudget;
  const rothIraFv = futureValue(rothIraContribution, years, inputs.annualReturn, inputs.retirementAccountExpense);
  const [rothIraBaseline] = solveBaselineForKnownWithdrawal({
    withdrawalCash: rothIraFv,
    requiredAfterTaxIncome: inputs.retirementIncome,
    baselineLongTermCapitalGainsShare: inputs.retirementLongTermCapitalGainsShare,
    state: inputs.retirementState,
    filingStatus: inputs.filingStatus,
    dependents: inputs.dependents,
  });
  const rothIraFootnotes = [...rothWithdrawalFootnotes];
  if (rothIraFraction === 0) {
    rothIraFootnotes.push({
      severity: "unavailable",
      text: "Direct Roth IRA contribution appears income-ineligible; consider a backdoor Roth IRA contribution.",
    });
  } else if (rothIraFraction < 1) {
    rothIraFootnotes.push({
      severity: "warning",
      text: "Direct Roth IRA contribution may be partially income-limited.",
    });
  }
  results.push(addCommonFields({
    account: "Roth IRA",
    contributionToday: rothIraContribution,
    futureValueBeforeTax: rothIraFv,
    futureValueAfterTax: rothIraFv,
    baselinePretaxIncomeBeforeWithdrawal: rothIraBaseline,
    taxDueAtWithdrawal: 0,
    currentTaxSavings: 0,
    eligibilityNote: rothIraEligibilityNote(inputs.currentIncome, inputs.filingStatus),
    assumptions: "After-tax contribution; qualified withdrawal tax-free.",
    footnotes: rothIraFootnotes,
    headerWarning: rothIraFootnotes.some((note) => note.severity !== "info"),
    contributionUnavailable: rothIraFraction === 0,
    contributionLowestEffectiveTaxRate: taxableContributionLowRate,
    contributionHighestEffectiveTaxRate: taxableContributionHighRate,
    withdrawalLowestEffectiveTaxRate: 0,
    withdrawalHighestEffectiveTaxRate: 0,
  }));

  const tradIraTaxableSlice = inputs.pretaxBudget * (1 - iraDeductionFraction);
  const tradIraTaxCost = incomeTaxCostOnIncomeSlice({
    currentIncome: inputs.currentIncome,
    currentLongTermCapitalGainsShare: inputs.currentLongTermCapitalGainsShare,
    incomeSlice: tradIraTaxableSlice,
    state: inputs.currentState,
    filingStatus: inputs.filingStatus,
    dependents: inputs.dependents,
  });
  const tradIraContribution = Math.max(0, inputs.pretaxBudget - payrollTaxOnBudget - tradIraTaxCost);
  const tradIraTaxSavings = Math.max(0, currentIncomeTaxOnBudget - tradIraTaxCost);
  const tradIraFv = futureValue(tradIraContribution, years, inputs.annualReturn, inputs.retirementAccountExpense);
  const nondeductibleBasis = tradIraContribution * (1 - iraDeductionFraction);
  const tradIraTaxableWithdrawal = Math.max(0, tradIraFv - nondeductibleBasis);
  const [tradIraBaseline, tradIraWithdrawalTax] = solveBaselineForOrdinaryWithdrawal({
    grossWithdrawal: tradIraTaxableWithdrawal,
    requiredAfterTaxIncome: inputs.retirementIncome,
    baselineLongTermCapitalGainsShare: inputs.retirementLongTermCapitalGainsShare,
    state: inputs.retirementState,
    filingStatus: inputs.filingStatus,
    dependents: inputs.dependents,
  });
  const tradIraRates = ordinarySliceLowHighRates({
    baselineIncome: tradIraBaseline,
    baselineLongTermCapitalGainsShare: inputs.retirementLongTermCapitalGainsShare,
    additionalOrdinaryIncome: tradIraTaxableWithdrawal,
    state: inputs.retirementState,
    filingStatus: inputs.filingStatus,
    dependents: inputs.dependents,
  });
  if (nondeductibleBasis > 0) tradIraRates[0] = 0;
  const tradIraFootnotes = [...traditionalIraWithdrawalFootnotes];
  if (iraDeductionFraction < 1) {
    tradIraFootnotes.push({
      severity: "warning",
      text: iraDeductionFraction > 0
        ? "Traditional IRA deduction appears partially income-limited."
        : "Traditional IRA deduction appears unavailable; modeled as nondeductible basis plus taxable earnings.",
    });
  }
  results.push(addCommonFields({
    account: "Traditional IRA",
    contributionToday: tradIraContribution,
    futureValueBeforeTax: tradIraFv,
    futureValueAfterTax: tradIraFv - tradIraWithdrawalTax,
    baselinePretaxIncomeBeforeWithdrawal: tradIraBaseline,
    taxDueAtWithdrawal: tradIraWithdrawalTax,
    currentTaxSavings: tradIraTaxSavings,
    eligibilityNote: traditionalIraEligibilityNote(iraDeductionFraction),
    assumptions: "Deductible portion gets current tax benefit; nondeductible basis is not taxed again.",
    footnotes: tradIraFootnotes,
    headerWarning: tradIraFootnotes.some((note) => note.severity !== "info"),
    contributionLowestEffectiveTaxRate: taxableContributionLowRate * (1 - iraDeductionFraction),
    contributionHighestEffectiveTaxRate: taxableContributionHighRate * (1 - iraDeductionFraction),
    withdrawalLowestEffectiveTaxRate: tradIraRates[0],
    withdrawalHighestEffectiveTaxRate: tradIraRates[1],
  }));

  const roth401kContribution = afterTaxBudget;
  const roth401kFv = futureValue(
    roth401kContribution,
    years,
    inputs.annualReturn,
    inputs.retirementAccountExpense + inputs.employerPlanExtraExpense,
  );
  const [roth401kBaseline] = solveBaselineForKnownWithdrawal({
    withdrawalCash: roth401kFv,
    requiredAfterTaxIncome: inputs.retirementIncome,
    baselineLongTermCapitalGainsShare: inputs.retirementLongTermCapitalGainsShare,
    state: inputs.retirementState,
    filingStatus: inputs.filingStatus,
    dependents: inputs.dependents,
  });
  const roth401kFootnotes = [...rothWithdrawalFootnotes, ...k401WithdrawalFootnotes, ...payrollContributionFootnotes];
  if (!inputs.has401k) {
    roth401kFootnotes.push({
      severity: "unavailable",
      text: "No 401k access selected, so this account is not modeled as available.",
    });
  }
  results.push(addCommonFields({
    account: "Roth 401k",
    contributionToday: roth401kContribution,
    futureValueBeforeTax: roth401kFv,
    futureValueAfterTax: inputs.has401k ? roth401kFv : null,
    baselinePretaxIncomeBeforeWithdrawal: roth401kBaseline,
    taxDueAtWithdrawal: 0,
    currentTaxSavings: 0,
    eligibilityNote: inputs.has401k ? "Requires access to a Roth 401k plan." : "Not modeled as available: no 401k access selected.",
    assumptions: "After-tax contribution; qualified withdrawal tax-free.",
    footnotes: roth401kFootnotes,
    headerWarning: roth401kFootnotes.some((note) => note.severity !== "info"),
    contributionUnavailable: !inputs.has401k,
    contributionLowestEffectiveTaxRate: taxableContributionLowRate,
    contributionHighestEffectiveTaxRate: taxableContributionHighRate,
    withdrawalLowestEffectiveTaxRate: 0,
    withdrawalHighestEffectiveTaxRate: 0,
  }));

  const trad401kContribution = Math.max(0, inputs.pretaxBudget - payrollTaxOnBudget);
  const trad401kFv = futureValue(
    trad401kContribution,
    years,
    inputs.annualReturn,
    inputs.retirementAccountExpense + inputs.employerPlanExtraExpense,
  );
  const [trad401kBaseline, trad401kWithdrawalTax] = solveBaselineForOrdinaryWithdrawal({
    grossWithdrawal: trad401kFv,
    requiredAfterTaxIncome: inputs.retirementIncome,
    baselineLongTermCapitalGainsShare: inputs.retirementLongTermCapitalGainsShare,
    state: inputs.retirementState,
    filingStatus: inputs.filingStatus,
    dependents: inputs.dependents,
  });
  const trad401kRates = ordinarySliceLowHighRates({
    baselineIncome: trad401kBaseline,
    baselineLongTermCapitalGainsShare: inputs.retirementLongTermCapitalGainsShare,
    additionalOrdinaryIncome: trad401kFv,
    state: inputs.retirementState,
    filingStatus: inputs.filingStatus,
    dependents: inputs.dependents,
  });
  const trad401kFootnotes = [...k401WithdrawalFootnotes, ...payrollContributionFootnotes];
  if (!inputs.has401k) {
    trad401kFootnotes.push({
      severity: "unavailable",
      text: "No 401k access selected, so this account is not modeled as available.",
    });
  }
  results.push(addCommonFields({
    account: "Traditional 401k",
    contributionToday: trad401kContribution,
    futureValueBeforeTax: trad401kFv,
    futureValueAfterTax: inputs.has401k ? trad401kFv - trad401kWithdrawalTax : null,
    baselinePretaxIncomeBeforeWithdrawal: trad401kBaseline,
    taxDueAtWithdrawal: trad401kWithdrawalTax,
    currentTaxSavings: currentIncomeTaxOnBudget,
    eligibilityNote: inputs.has401k ? "Requires access to a traditional 401k plan." : "Not modeled as available: no 401k access selected.",
    assumptions: "Pre-tax contribution; withdrawal taxed as ordinary income.",
    footnotes: trad401kFootnotes,
    headerWarning: trad401kFootnotes.some((note) => note.severity !== "info"),
    contributionUnavailable: !inputs.has401k,
    contributionLowestEffectiveTaxRate: payrollTaxRateOnBudget,
    contributionHighestEffectiveTaxRate: payrollTaxRateOnBudget,
    withdrawalLowestEffectiveTaxRate: trad401kRates[0],
    withdrawalHighestEffectiveTaxRate: trad401kRates[1],
  }));

  const hsaPayrollSavings = inputs.hsaPayrollContribution ? payrollTaxOnBudget : 0;
  const hsaContribution = inputs.hsaPayrollContribution
    ? inputs.pretaxBudget
    : Math.max(0, inputs.pretaxBudget - payrollTaxOnBudget);
  const hsaFv = futureValue(
    hsaContribution,
    years,
    inputs.annualReturn,
    inputs.retirementAccountExpense + inputs.hsaExtraExpense,
  );
  const [hsaBaseline, hsaWithdrawalTax] = solveBaselineForOrdinaryWithdrawal({
    grossWithdrawal: hsaFv,
    requiredAfterTaxIncome: inputs.retirementIncome,
    baselineLongTermCapitalGainsShare: inputs.retirementLongTermCapitalGainsShare,
    state: inputs.retirementState,
    filingStatus: inputs.filingStatus,
    dependents: inputs.dependents,
  });
  const hsaRates = ordinarySliceLowHighRates({
    baselineIncome: hsaBaseline,
    baselineLongTermCapitalGainsShare: inputs.retirementLongTermCapitalGainsShare,
    additionalOrdinaryIncome: hsaFv,
    state: inputs.retirementState,
    filingStatus: inputs.filingStatus,
    dependents: inputs.dependents,
  });
  const hsaContributionRate = inputs.hsaPayrollContribution ? 0 : payrollTaxRateOnBudget;
  const hsaFootnotes = [...hsaWithdrawalFootnotes, ...payrollContributionFootnotes];
  if (!inputs.hasHsa) {
    hsaFootnotes.push({
      severity: "unavailable",
      text: "HSA eligibility is not selected, so this account is not modeled as available.",
    });
  } else if (!inputs.hsaPayrollContribution) {
    hsaFootnotes.push({
      severity: "warning",
      text: "HSA contribution is not modeled through payroll, so Social Security and Medicare tax savings are unavailable.",
    });
  }
  results.push(addCommonFields({
    account: "HSA",
    contributionToday: hsaContribution,
    futureValueBeforeTax: hsaFv,
    futureValueAfterTax: inputs.hasHsa ? hsaFv - hsaWithdrawalTax : null,
    baselinePretaxIncomeBeforeWithdrawal: hsaBaseline,
    taxDueAtWithdrawal: hsaWithdrawalTax,
    currentTaxSavings: currentIncomeTaxOnBudget + hsaPayrollSavings,
    eligibilityNote: inputs.hasHsa ? "Requires HSA eligibility." : "Not modeled as available: HSA eligibility not selected.",
    assumptions: inputs.withdrawalAge >= 65
      ? "Modeled as nonmedical age-65+ withdrawal: ordinary income tax, no penalty. Payroll contributions add FICA savings when selected."
      : "Before age 65, HSA withdrawals generally need qualified medical expenses to avoid additional tax.",
    footnotes: hsaFootnotes,
    headerWarning: hsaFootnotes.some((note) => note.severity !== "info"),
    contributionUnavailable: !inputs.hasHsa,
    contributionLowestEffectiveTaxRate: hsaContributionRate,
    contributionHighestEffectiveTaxRate: hsaContributionRate,
    withdrawalLowestEffectiveTaxRate: hsaRates[0],
    withdrawalHighestEffectiveTaxRate: hsaRates[1],
  }));

  const taxableContribution = afterTaxBudget;
  const taxableFv = futureValue(
    taxableContribution,
    years,
    inputs.annualReturn,
    inputs.taxableAnnualTaxDrag + inputs.retirementAccountExpense,
  );
  const [, taxableFinalTax, taxableGainWithdrawn, taxableBaselineIncome] = solveTaxableBrokerageWithdrawalForNet({
    accountValue: taxableFv,
    basis: taxableContribution,
    requiredAfterTaxIncome: inputs.retirementIncome,
    baselineLongTermCapitalGainsShare: inputs.retirementLongTermCapitalGainsShare,
    state: inputs.retirementState,
    filingStatus: inputs.filingStatus,
    dependents: inputs.dependents,
  });
  const taxableRates = longTermCapitalGainsSliceLowHighRates({
    baselineIncome: taxableBaselineIncome,
    baselineLongTermCapitalGainsShare: inputs.retirementLongTermCapitalGainsShare,
    additionalLongTermCapitalGains: taxableGainWithdrawn,
    state: inputs.retirementState,
    filingStatus: inputs.filingStatus,
    dependents: inputs.dependents,
  });
  if (taxableContribution > 0) taxableRates[0] = 0;
  results.push(addCommonFields({
    account: "Taxable brokerage",
    contributionToday: taxableContribution,
    futureValueBeforeTax: taxableFv,
    futureValueAfterTax: taxableFv - taxableFinalTax,
    baselinePretaxIncomeBeforeWithdrawal: taxableBaselineIncome,
    taxDueAtWithdrawal: taxableFinalTax,
    currentTaxSavings: 0,
    eligibilityNote: "No account-specific eligibility restriction modeled.",
    assumptions: "After-tax contribution; final unrealized gain taxed as long-term capital gain.",
    contributionLowestEffectiveTaxRate: taxableContributionLowRate,
    contributionHighestEffectiveTaxRate: taxableContributionHighRate,
    withdrawalLowestEffectiveTaxRate: taxableRates[0],
    withdrawalHighestEffectiveTaxRate: taxableRates[1],
  }));

  const ranked = [...results].sort((a, b) => {
    const aValue = a.futureValueAfterTax === null ? -Infinity : a.futureValueAfterTax;
    const bValue = b.futureValueAfterTax === null ? -Infinity : b.futureValueAfterTax;
    if (bValue !== aValue) return bValue - aValue;
    return a.account.localeCompare(b.account);
  });
  ranked.forEach((row, index) => {
    row.rank = index + 1;
  });
  return ranked;
}

function valueFromNumber(id) {
  const value = Number(document.getElementById(id).value);
  return Number.isFinite(value) ? value : 0;
}

function syncRangeOutput(id) {
  const input = document.getElementById(id);
  const output = document.getElementById(`${id}-output`);
  if (!input || !output) return;
  output.textContent = `${valueFromNumber(id)}%`;
}

function syncRangeOutputs() {
  syncRangeOutput("current-ltcg-share");
  syncRangeOutput("retirement-ltcg-share");
}

function getInputs() {
  return {
    currentIncome: valueFromNumber("current-income"),
    retirementIncome: valueFromNumber("retirement-income"),
    currentState: document.getElementById("current-state").value,
    retirementState: document.getElementById("retirement-state").value,
    filingStatus: document.getElementById("filing-status").value,
    dependents: Math.max(0, Math.trunc(valueFromNumber("dependents"))),
    currentAge: Math.max(0, Math.trunc(valueFromNumber("current-age"))),
    withdrawalAge: Math.max(0, Math.trunc(valueFromNumber("withdrawal-age"))),
    pretaxBudget: valueFromNumber("pretax-budget"),
    primaryEarnerShare: valueFromNumber("primary-earner-share") / 100,
    currentLongTermCapitalGainsShare: valueFromNumber("current-ltcg-share") / 100,
    retirementLongTermCapitalGainsShare: valueFromNumber("retirement-ltcg-share") / 100,
    annualReturn: valueFromNumber("annual-return") / 100,
    retirementAccountExpense: valueFromNumber("base-expense") / 100,
    employerPlanExtraExpense: valueFromNumber("extra-401k-expense") / 100,
    taxableAnnualTaxDrag: valueFromNumber("taxable-drag") / 100,
    hsaExtraExpense: valueFromNumber("extra-hsa-expense") / 100,
    hsaPayrollContribution: document.getElementById("hsa-payroll").checked,
    coveredByWorkplacePlan: document.getElementById("workplace-plan").checked,
    spouseCoveredByWorkplacePlan: document.getElementById("spouse-workplace-plan").checked,
    has401k: document.getElementById("has-401k").checked,
    hasHsa: document.getElementById("has-hsa").checked,
  };
}

function formatMoney(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "Not available";
  return moneyFormatter.format(value);
}

function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "Not available";
  return `${(value * 100).toFixed(2)}%`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function prepareFootnotes(results) {
  const footnoteMap = new Map();
  const footnotes = [];
  results.forEach((row) => {
    row.footnoteNumbers = [];
    (row.footnotes || []).forEach((note) => {
      if (!note || !note.text) return;
      if (!footnoteMap.has(note.text)) {
        footnoteMap.set(note.text, footnotes.length + 1);
        footnotes.push({ number: footnotes.length + 1, text: note.text });
      }
      row.footnoteNumbers.push(footnoteMap.get(note.text));
    });
  });
  return footnotes;
}

function accountLabelWithFootnotes(row) {
  const label = escapeHtml(row.account);
  if (!row.footnoteNumbers || !row.footnoteNumbers.length) return label;
  return `${label}<sup>${row.footnoteNumbers.join(",")}</sup>`;
}

function accountHeaderClass(row) {
  return row.headerWarning ? "account-warning-header" : "";
}

function accountCellClass(row, cellClass = "", unavailable = false) {
  return [
    cellClass,
    row.contributionUnavailable ? "account-unavailable-cell" : "",
    unavailable ? "unavailable" : "",
  ].filter(Boolean).join(" ");
}

function updateRetirementPretaxEquivalent(topAccount, footnoteNumber) {
  const output = document.getElementById("retirement-pretax-equivalent");
  if (!output) return;
  if (!topAccount || topAccount.baselinePretaxIncomeBeforeWithdrawal === null) {
    output.textContent = "";
    return;
  }
  const totalGrossResources = topAccount.baselinePretaxIncomeBeforeWithdrawal + topAccount.futureValueBeforeTax;
  output.innerHTML = `(${formatMoney(totalGrossResources)} pretax income<sup>${footnoteNumber}</sup>)`;
}

function assumptionDetails(row) {
  return `<details class="assumption-details"><summary>Show</summary><p>${escapeHtml(row.assumptions)}</p></details>`;
}

function formatCompactMoney(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "N/A";
  const amount = Math.abs(value);
  if (amount >= 1000000) return `$${(value / 1000000).toFixed(1)}M`;
  if (amount >= 10000) return `$${Math.round(value / 1000)}k`;
  if (amount >= 1000) return `$${(value / 1000).toFixed(1)}k`;
  return `$${Math.round(value)}`;
}

function uniqueChartTicks(ticks) {
  const seen = new Set();
  return ticks.filter((tick) => {
    const key = `${tick.year}-${tick.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function renderGrowthChart(container, inputs, results) {
  if (!container) return;
  const availableResults = results.filter((row) => row.futureValueAfterTax !== null);
  const years = Math.max(0, inputs.withdrawalAge - inputs.currentAge);
  if (!availableResults.length || years <= 0) {
    container.innerHTML = `
      <div class="growth-chart-header">
        <h2>Projected growth over time</h2>
        <span>Choose a later withdrawal age to show a growth path.</span>
      </div>
    `;
    return;
  }

  const series = availableResults.map((row, index) => ({
    account: row.account,
    color: CHART_COLORS[index % CHART_COLORS.length],
    points: [{ year: 0, value: inputs.pretaxBudget }],
  }));
  const seriesByAccount = new Map(series.map((item) => [item.account, item]));

  for (let year = 1; year <= years; year += 1) {
    const yearResults = year === years
      ? results
      : optimizeIncrementalRetirementDollar({
        ...inputs,
        withdrawalAge: inputs.currentAge + year,
      });
    yearResults.forEach((row) => {
      const accountSeries = seriesByAccount.get(row.account);
      if (!accountSeries || row.futureValueAfterTax === null) return;
      accountSeries.points.push({ year, value: row.futureValueAfterTax });
    });
  }

  const chartWidth = 920;
  const chartHeight = 340;
  const margin = { top: 24, right: 22, bottom: 54, left: 72 };
  const plotWidth = chartWidth - margin.left - margin.right;
  const plotHeight = chartHeight - margin.top - margin.bottom;
  const allValues = series.flatMap((item) => item.points.map((point) => point.value));
  const maxValue = Math.max(inputs.pretaxBudget, ...allValues, 1);
  const yMax = maxValue * 1.08;
  const xForYear = (year) => margin.left + (year / years) * plotWidth;
  const yForValue = (value) => margin.top + plotHeight - (Math.max(0, value) / yMax) * plotHeight;
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((share) => yMax * share);
  const midpointYear = Math.round(years / 2);
  const xTicks = uniqueChartTicks([
    { year: 0, label: `Age ${inputs.currentAge}` },
    { year: midpointYear, label: `Age ${inputs.currentAge + midpointYear}` },
    { year: years, label: `Age ${inputs.withdrawalAge}` },
  ]);

  const grid = yTicks.map((tick) => {
    const y = yForValue(tick);
    return `
      <line class="chart-grid" x1="${margin.left}" y1="${y.toFixed(2)}" x2="${chartWidth - margin.right}" y2="${y.toFixed(2)}"></line>
      <text class="chart-tick-label" x="${margin.left - 10}" y="${(y + 4).toFixed(2)}" text-anchor="end">${formatCompactMoney(tick)}</text>
    `;
  }).join("");

  const xAxisTicks = xTicks.map((tick) => {
    const x = xForYear(tick.year);
    return `
      <line class="chart-axis" x1="${x.toFixed(2)}" y1="${margin.top + plotHeight}" x2="${x.toFixed(2)}" y2="${margin.top + plotHeight + 5}"></line>
      <text class="chart-tick-label" x="${x.toFixed(2)}" y="${margin.top + plotHeight + 24}" text-anchor="middle">${escapeHtml(tick.label)}</text>
    `;
  }).join("");

  const lines = series.map((item) => {
    const points = item.points
      .map((point) => `${xForYear(point.year).toFixed(2)},${yForValue(point.value).toFixed(2)}`)
      .join(" ");
    const finalPoint = item.points[item.points.length - 1];
    return `
      <polyline class="chart-line" points="${points}" stroke="${item.color}"></polyline>
      <circle class="chart-endpoint" cx="${xForYear(finalPoint.year).toFixed(2)}" cy="${yForValue(finalPoint.value).toFixed(2)}" r="4.5" fill="${item.color}"></circle>
    `;
  }).join("");

  const legend = series.map((item) => {
    const finalPoint = item.points[item.points.length - 1];
    return `
      <div class="chart-legend-item">
        <span class="chart-legend-swatch" style="background:${item.color}"></span>
        <span>${escapeHtml(item.account)} <span class="chart-legend-value">${formatMoney(finalPoint.value)}</span></span>
      </div>
    `;
  }).join("");

  container.innerHTML = `
    <div class="growth-chart-header">
      <h2>Projected growth over time</h2>
      <span>Starts at ${formatMoney(inputs.pretaxBudget)} pretax equivalent; endpoints match after-tax withdrawal value.</span>
    </div>
    <svg role="img" viewBox="0 0 ${chartWidth} ${chartHeight}" aria-label="Projected growth paths for retirement account choices">
      <line class="chart-axis" x1="${margin.left}" y1="${margin.top + plotHeight}" x2="${chartWidth - margin.right}" y2="${margin.top + plotHeight}"></line>
      <line class="chart-axis" x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotHeight}"></line>
      ${grid}
      ${xAxisTicks}
      ${lines}
      <text class="chart-axis-label" x="${margin.left + plotWidth / 2}" y="${chartHeight - 10}" text-anchor="middle">Age</text>
    </svg>
    <div class="chart-legend">${legend}</div>
  `;
}

function renderResults() {
  syncRangeOutputs();
  const table = document.getElementById("results-table");
  const cards = document.getElementById("results-cards");
  const topAccount = document.getElementById("top-account");
  const topAccountContext = document.getElementById("top-account-context");
  const growthChart = document.getElementById("growth-chart");
  const footnotes = document.getElementById("footnotes");

  try {
    const inputs = getInputs();
    const results = optimizeIncrementalRetirementDollar(inputs);
    const footnoteEntries = prepareFootnotes(results);
    const best = results.find((row) => row.futureValueAfterTax !== null);
    const topPretaxFootnoteNumber = footnoteEntries.length + 1;
    footnoteEntries.push({
      number: topPretaxFootnoteNumber,
      text: best
        ? `Pretax income estimate assumes the top-ranked account, ${best.account}, is used for the modeled account withdrawal.`
        : "Pretax income estimate assumes the top-ranked available account is used for the modeled account withdrawal.",
    });
    updateRetirementPretaxEquivalent(best, topPretaxFootnoteNumber);

    const metrics = [
      ["Rank", (row) => String(row.rank), "rank-row"],
      ["Available after withdrawal", (row) => formatMoney(row.futureValueAfterTax)],
      ["Contribution pretax equivalent", (row) => formatMoney(row.pretaxIncomeContributionToday)],
      ["Actual contribution amount", (row) => formatMoney(row.postTaxContributionToday)],
      ["Contribution effective tax rate", (row) => formatPercent(row.contributionEffectiveTaxRate)],
      ["Contribution lowest effective tax rate", (row) => formatPercent(row.contributionLowestEffectiveTaxRate)],
      ["Contribution highest effective tax rate", (row) => formatPercent(row.contributionHighestEffectiveTaxRate)],
      ["Current tax savings", (row) => formatMoney(row.currentTaxSavings)],
      ["Future value before tax", (row) => formatMoney(row.futureValueBeforeTax)],
      ["Tax due at withdrawal", (row) => formatMoney(row.taxDueAtWithdrawal)],
      ["Future value after tax", (row) => formatMoney(row.futureValueAfterTax)],
      ["Withdrawal effective tax rate", (row) => formatPercent(row.withdrawalEffectiveTaxRate)],
      ["Withdrawal lowest effective tax rate", (row) => formatPercent(row.withdrawalLowestEffectiveTaxRate)],
      ["Withdrawal highest effective tax rate", (row) => formatPercent(row.withdrawalHighestEffectiveTaxRate)],
      ["Total fees and tax impact", (row) => formatMoney(row.totalFeesAndTaxImpact)],
      ["Total fees and tax impact %", (row) => formatPercent(row.totalFeesAndTaxImpactPct)],
      ["Net total growth %", (row) => formatPercent(row.netTotalGrowthPct)],
      ["Net annualized growth %", (row) => formatPercent(row.netAnnualizedGrowthPct)],
      ["Modeled assumptions", (row) => assumptionDetails(row), "", "note-cell"],
    ];

    const header = `<thead><tr><th>Metric</th>${results.map((row) => (
      `<th class="${accountHeaderClass(row)}">${accountLabelWithFootnotes(row)}</th>`
    )).join("")}</tr></thead>`;
    const body = metrics.map(([name, formatter, rowClass = "", cellClass = ""]) => (
      `<tr class="${rowClass}"><td>${escapeHtml(name)}</td>${results.map((row) => {
        const unavailable = row.futureValueAfterTax === null && name === "Available after withdrawal";
        const classNames = accountCellClass(row, cellClass, unavailable);
        return `<td class="${classNames}">${formatter(row)}</td>`;
      }).join("")}</tr>`
    )).join("");

    table.innerHTML = `${header}<tbody>${body}</tbody>`;
    cards.innerHTML = results.map((row) => {
      const unavailable = row.futureValueAfterTax === null;
      const accountLabel = accountLabelWithFootnotes(row);
      const cardClass = [
        "result-card",
        row.headerWarning ? "benefit-warning-card" : "",
        row.contributionUnavailable || unavailable ? "unavailable-card" : "",
      ].filter(Boolean).join(" ");
      return `
        <article class="${cardClass}">
          <div class="card-rank">
            <span>Rank ${row.rank}</span>
            <strong>${accountLabel}</strong>
          </div>
          <div class="card-value">
            <span>Available after withdrawal</span>
            <strong>${formatMoney(row.futureValueAfterTax)}</strong>
          </div>
          <dl class="mobile-metrics">
            <div><dt>Contribution pretax equivalent</dt><dd>${formatMoney(row.pretaxIncomeContributionToday)}</dd></div>
            <div><dt>Actual contribution amount</dt><dd>${formatMoney(row.postTaxContributionToday)}</dd></div>
            <div><dt>Contribution tax rate</dt><dd>${formatPercent(row.contributionEffectiveTaxRate)}</dd></div>
            <div><dt>Future value before tax</dt><dd>${formatMoney(row.futureValueBeforeTax)}</dd></div>
            <div><dt>Tax due at withdrawal</dt><dd>${formatMoney(row.taxDueAtWithdrawal)}</dd></div>
            <div><dt>Withdrawal tax rate</dt><dd>${formatPercent(row.withdrawalEffectiveTaxRate)}</dd></div>
            <div><dt>Fees and tax impact</dt><dd>${formatMoney(row.totalFeesAndTaxImpact)}</dd></div>
            <div><dt>Net annualized growth</dt><dd>${formatPercent(row.netAnnualizedGrowthPct)}</dd></div>
          </dl>
          <details class="card-details">
            <summary>Modeled assumptions</summary>
            <p>${escapeHtml(row.assumptions)}</p>
          </details>
        </article>
      `;
    }).join("");
    topAccount.textContent = best ? `${best.account}: ${formatMoney(best.futureValueAfterTax)}` : "No available account";
    if (topAccountContext) {
      topAccountContext.textContent = best ? `End value of ${formatMoney(inputs.pretaxBudget)} contribution` : "";
    }
    renderGrowthChart(growthChart, inputs, results);
    footnotes.innerHTML = footnoteEntries.map((note) => (
      `<p><sup>${note.number}</sup> ${escapeHtml(note.text)}</p>`
    )).join("");
  } catch (error) {
    table.innerHTML = `<tbody><tr><td>Error</td><td>${escapeHtml(error.message)}</td></tr></tbody>`;
    cards.innerHTML = `<article class="result-card"><strong>Error</strong><p>${escapeHtml(error.message)}</p></article>`;
    topAccount.textContent = "Check inputs";
    if (topAccountContext) topAccountContext.textContent = "";
    if (growthChart) growthChart.innerHTML = "";
    footnotes.innerHTML = "";
  }
}

function populateStateSelects() {
  const states = availableStates(taxRows);
  const options = states.map((state) => `<option value="${escapeHtml(state)}">${escapeHtml(state)}</option>`).join("");
  const currentState = document.getElementById("current-state");
  const retirementState = document.getElementById("retirement-state");
  currentState.innerHTML = options;
  retirementState.innerHTML = options;
  currentState.value = states.includes("Minnesota") ? "Minnesota" : states[0];
  retirementState.value = states.includes("Minnesota") ? "Minnesota" : states[0];
}

async function init() {
  const response = await fetch(TAX_DATA_URL);
  if (!response.ok) throw new Error(`Could not load tax data: ${response.status}`);
  taxRows = normalizeTaxRows(parseCsv(await response.text()));
  populateStateSelects();
  document.getElementById("optimizer-form").addEventListener("input", renderResults);
  document.getElementById("optimizer-form").addEventListener("change", renderResults);
  renderResults();
}

init().catch((error) => {
  document.getElementById("top-account").textContent = "Tax data failed to load";
  document.getElementById("results-table").innerHTML = `<tbody><tr><td>Error</td><td>${escapeHtml(error.message)}</td></tr></tbody>`;
});
