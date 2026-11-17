export const families = {
  inquiry:['询价单','XJ','采购','supplier'], purchaseOrder:['采购订单','CG','采购','supplier'],
  purchase:['采购入库单','RK','采购','supplier','in'], purchaseReturn:['采购退货单','CT','采购','supplier','out'],
  purchaseExchange:['采购换货单','CH','采购','supplier','exchange'],
  purchaseFee:['采购费用分摊','CF','采购','supplier','fee'],
  quote:['报价单','BJ','销售','customer'], salesOrder:['销售订单','XD','销售','customer'],
  sale:['销售出库单','XS','销售','customer','out'], salesReturn:['销售退货单','XT','销售','customer','in'],
  exchange:['销售换货单','XH','销售','customer','exchange'], salesFee:['销售费用分摊','XF','销售','customer','fee'],
  transferOrder:['调拨订单','DD','仓储'], transfer:['调拨单','DB','仓储',null,'transfer'],
  loss:['报损单','BS','仓储',null,'out'], gain:['报溢单','BY','仓储',null,'in'],
  miscOut:['其他出库单','QC','仓储',null,'out'], miscIn:['其他入库单','QR','仓储',null,'in'],
  issue:['内部领用单','LY','仓储',null,'out'], issueReturn:['领用退回单','LT','仓储',null,'in'],
  revalue:['成本调价单','TJ','仓储',null,'revalue'], count:['盘点单','PD','库存',null,'count'],
  openingStock:['期初库存商品','QK','资料',null,'in'],
  openingAR:['期初应收','QS','资料','customer','cash'], openingAP:['期初应付','QF','资料','supplier','cash'],
  openingCash:['期初收支账户','QZ','资料',null,'cash'], openingBalance:['期初资产负债','QJ','资料',null,'journal'],
  receipt:['收款单','SK','财务','customer','cash'], payment:['付款单','FK','财务','supplier','cash'],
  expense:['费用单','FY','财务',null,'cash'], deferred:['待摊费用单','DT','财务',null,'cash'],
  income:['其他收入单','SR','财务',null,'cash'], advanceIn:['预收款单','YS','财务','customer','cash'],
  advanceOut:['预付款单','YF','财务','supplier','cash'], cashTransfer:['存取转账单','ZZ','财务',null,'cash'],
  voucher:['会计凭证','PZ','财务',null,'journal']
};
export const masters = {
  products:['商品信息','资料'], bundles:['套餐信息','资料'], partners:['客户/供应商','资料'],
  warehouses:['存货仓库','资料'], accounts:['现金银行','资料'], expenses:['费用/收入科目','资料'],
  ledgerAccounts:['会计科目','资料'], carriers:['物流公司','资料'], shippingTemplates:['物流服务模板','资料'],
  freight:['运费结算','资料'], supplierPrices:['供货商价格本','采购'], customerPrices:['客户价格本','销售'],
  tiers:['数量阶梯价','资料'], users:['职员管理','系统'], owners:['货主管理','系统'],
  templates:['打印模板中心','系统'], printers:['远程打印配置','系统'], settings:['系统配置','系统']
};
export const reports = {
  '采购':['采购订单统计','采购订单明细查询','商品采购统计','商品采购明细查询','采购波动分析'],
  '销售':['销售订单统计','销售订单明细查询','销售及毛利统计','销售明细查询','销售优惠统计','销售波动分析','畅销/滞销商品表'],
  '客户':['往来单位应收应付','对账'],
  '库存':['库存状况查询','分仓库存查询','可销售库存查询','可发货库存查询','全月商品出库成本表','序列号跟踪','批次号跟踪','临期商品预警','调拨在途统计','库存调货统计','库存变动统计','商品进销存变动统计','库存积压统计','库龄统计','库存周转率'],
  '财务':['按单结算统计','按单结算查询','现金银行变动表','费用及其他收入统计','利润表','资产负债表','会计分录查询','月结存'],
  '综合':['经营报告','综合统计月报','经手人业务统计','往来单位业务统计','往来单位收付款分析','客户流失预警分析'],
  '系统':['系统日志','导出记录']
};
export const statusNames = {draft:'草稿',pending:'待审核',approved:'已审核',posted:'已记账',settled:'已结算',stopped:'截停',rejected:'驳回',deleted:'已删除'};
export const stockEffects = ['in','out','transfer','exchange','count','revalue'];

export const relatedDocuments = {
  purchaseOrder:['inquiry'], purchase:['purchaseOrder','inquiry'], purchaseReturn:['purchase'], purchaseExchange:['purchase'],
  purchaseFee:['purchase'], salesOrder:['quote'], sale:['salesOrder','quote'], salesReturn:['sale'],
  exchange:['sale'], salesFee:['sale'], transfer:['transferOrder'], receipt:['sale','exchange'],
  payment:['purchase','purchaseExchange','sale']
};
export const submittedSources = ['inquiry','quote','salesOrder','purchaseOrder','transferOrder'];
export const settlementFooters = ['sale','salesOrder','purchaseOrder','purchase'];
export const logisticsFooters = [...settlementFooters,'quote','salesReturn','purchaseReturn','purchaseExchange','exchange','transferOrder','transfer'];

export const orderFulfillment = {purchaseOrder:'purchase',salesOrder:'sale'};
